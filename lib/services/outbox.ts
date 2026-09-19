import "server-only";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { OrderError } from "../domain/order-input";
import { isOrgAdmin } from "../domain/roles";
import { assertActor, UserActor } from "./actor";
import { serializable } from "./transactions";

export type EventPublisher = (message: { eventId: string; deduplicationId: string }) => Promise<void>;

// Publisher timeout must be shorter than the lease. Unsuccessful delivery must throw.
export async function dispatchOutbox(db: PrismaClient, publish: EventPublisher, limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new OrderError("Limite de publicação inválido.");
  const now = new Date();
  const candidates = await db.outboxMessage.findMany({ where: {
    status: "PENDING", availableAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
  }, orderBy: { createdAt: "asc" }, take: limit });
  let published = 0;
  let failed = 0;
  for (const message of candidates) {
    const leaseToken = randomUUID();
    const claimTime = new Date();
    const claim = await db.outboxMessage.updateMany({ where: {
      id: message.id, status: "PENDING", availableAt: { lte: claimTime },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: claimTime } }],
    }, data: { leaseToken, leaseUntil: new Date(claimTime.getTime() + 60000), attempts: { increment: 1 } } });
    if (!claim.count) continue;
    try {
      // Separador com underscore: o QStash recusa dois-pontos no id de deduplicação.
      await publish({ eventId: message.eventId, deduplicationId: message.id + "_" + leaseToken });
      const result = await db.outboxMessage.updateMany({ where: { id: message.id, leaseToken }, data: {
        status: "PUBLISHED", publishedAt: new Date(), leaseUntil: null, leaseToken: null, lastError: null,
      } });
      published += result.count;
    } catch (error) {
      // Só códigos nossos entram no registro: mensagem de terceiro pode carregar
      // cabeçalho ou credencial.
      const motivo = error instanceof Error && /^QSTASH_[A-Z0-9_]+$/.test(error.message)
        ? error.message : "PUBLISH_FAILED";
      await db.outboxMessage.updateMany({ where: { id: message.id, leaseToken }, data: {
        status: message.attempts + 1 >= 8 ? "FAILED" : "PENDING", leaseUntil: null, leaseToken: null,
        availableAt: new Date(Date.now() + Math.min(3600000, 1000 * 2 ** (message.attempts + 1))),
        lastError: motivo,
      } });
      failed++;
    }
  }
  return { published, failed };
}

export async function requeueOrderEvent(db: PrismaClient, actor: UserActor, eventId: string) {
  return serializable(db, async (tx) => {
    await assertActor(tx, actor);
    const user = await tx.user.findUniqueOrThrow({ where: { id: actor.userId } });
    if (!isOrgAdmin(user.role)) throw new OrderError("Apenas administradores podem reprocessar eventos.");
    const event = await tx.integrationEvent.findFirst({ where: { id: eventId, marketplace: { organizationId: actor.organizationId } }, include: { outbox: true } });
    if (!event || !event.outbox) throw new OrderError("Evento não encontrado.");
    if (event.status === "PROCESSED" || event.status === "IGNORED") throw new OrderError("Evento já concluído.");
    if (event.outbox.leaseUntil && event.outbox.leaseUntil > new Date()) throw new OrderError("Publicação em andamento.");
    await tx.integrationEvent.update({ where: { id: eventId }, data: { status: "PENDING", lastError: null, processedAt: null } });
    await tx.outboxMessage.update({ where: { eventId }, data: {
      status: "PENDING", attempts: 0, availableAt: new Date(), publishedAt: null, leaseUntil: null, leaseToken: null, lastError: null,
    } });
    await tx.auditLog.create({ data: {
      action: "UPDATE", entity: "INTEGRATION_EVENT", entityId: eventId, organizationId: actor.organizationId,
      userId: actor.userId, integrationEventId: eventId, details: "Evento enviado para reprocessamento.",
    } });
  });
}
