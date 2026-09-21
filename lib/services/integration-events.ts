import "server-only";
import { MarketplaceConnection, Prisma, PrismaClient } from "@prisma/client";
import { objectInput, OrderError, parseIntegratedOrder, textInput } from "../domain/order-input";
import { applyIntegratedOrder } from "./sales";
import { registrarTentativa } from "./event-history";
import { serializable } from "./transactions";

// After this many attempts the event stops being retried and waits for an operator,
// instead of staying PENDING forever once the queue gives up on it.
export const MAX_PROCESSING_ATTEMPTS = 8;

export interface RecordedNotification {
  /// Resolved by a trusted adapter from the provider account, never from a browser field.
  marketplaceId: string;
  connectionId?: string | null;
  externalEventId: string;
  externalOrderId: string;
  /// Raw provider notification, stored as received.
  payload: unknown;
}

export interface EventContext {
  id: string;
  externalEventId: string;
  externalOrderId: string;
  payload: Prisma.JsonValue;
  marketplaceId: string;
  organizationId: string;
  connection: MarketplaceConnection | null;
}

// Turns the stored notification into an order snapshot, usually by calling the provider API.
export type OrderSnapshotResolver = (event: EventContext) => Promise<unknown>;

function rawPayload(input: unknown): Prisma.InputJsonObject {
  const value = objectInput(input);
  const json = JSON.stringify(value);
  if (json.length > 8192) throw new OrderError("Notificação excede o limite.");
  return JSON.parse(json) as Prisma.InputJsonObject;
}

export async function recordOrderEvent(db: PrismaClient, input: RecordedNotification) {
  const marketplaceId = textInput(input.marketplaceId, "Marketplace");
  const externalEventId = textInput(input.externalEventId, "Evento externo", 300);
  const externalOrderId = textInput(input.externalOrderId, "Pedido externo");
  const connectionId = input.connectionId ? textInput(input.connectionId, "Conexão") : null;
  const payload = rawPayload(input.payload);
  try {
    return await serializable(db, async (tx) => {
      if (!await tx.marketplace.findFirst({ where: { id: marketplaceId, active: true } })) {
        throw new OrderError("Marketplace inativo ou inexistente.");
      }
      if (connectionId && !await tx.marketplaceConnection.findFirst({
        where: { id: connectionId, marketplaceId, status: "ACTIVE" }, select: { id: true },
      })) throw new OrderError("Conexão inativa ou de outro marketplace.");
      const existing = await tx.integrationEvent.findUnique({
        where: { marketplaceId_externalEventId: { marketplaceId, externalEventId } },
      });
      if (existing) return existing;
      return tx.integrationEvent.create({ data: {
        marketplaceId, connectionId, externalEventId, externalOrderId, payload, outbox: { create: {} },
      } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await db.integrationEvent.findUnique({
        where: { marketplaceId_externalEventId: { marketplaceId, externalEventId } },
      });
      if (existing) return existing;
    }
    throw error;
  }
}

export async function processOrderEvent(db: PrismaClient, eventId: string, resolve: OrderSnapshotResolver) {
  textInput(eventId, "Evento");
  const event = await db.integrationEvent.findUnique({
    where: { id: eventId }, include: { marketplace: true, connection: true },
  });
  if (!event) throw new OrderError("Evento não encontrado.");
  if (event.status !== "PENDING") return event.status;

  // Claim one attempt before doing any work, so a retry storm cannot loop unbounded.
  const claim = await db.integrationEvent.updateMany({
    where: { id: eventId, status: "PENDING" }, data: { attempts: { increment: 1 } },
  });
  if (!claim.count) {
    return (await db.integrationEvent.findUniqueOrThrow({ where: { id: eventId }, select: { status: true } })).status;
  }
  const attempts = event.attempts + 1;
  const comecou = Date.now();

  try {
    if (!event.marketplace.active) throw new OrderError("Marketplace inativo.");
    if (attempts > MAX_PROCESSING_ATTEMPTS) throw new OrderError("Número de tentativas excedido.");
    // Resolving reaches the provider API: it must never hold a database transaction open.
    const order = parseIntegratedOrder(await resolve({
      id: event.id, externalEventId: event.externalEventId, externalOrderId: event.externalOrderId,
      payload: event.payload, marketplaceId: event.marketplaceId,
      organizationId: event.marketplace.organizationId, connection: event.connection,
    }));
    return await serializable(db, async (tx) => {
      // Re-checked inside the transaction: a concurrent delivery may have finished first.
      const current = await tx.integrationEvent.findUniqueOrThrow({
        where: { id: eventId }, select: { status: true },
      });
      if (current.status !== "PENDING") return current.status;
      const outcome = await applyIntegratedOrder(tx, {
        eventId, marketplaceId: event.marketplaceId, organizationId: event.marketplace.organizationId,
        externalEventId: event.externalEventId,
      }, order);
      await tx.integrationEvent.update({
        where: { id: eventId }, data: { status: outcome, processedAt: new Date(), lastError: null },
      });
      if (event.connectionId) {
        await tx.marketplaceConnection.update({
          where: { id: event.connectionId }, data: { lastSyncedAt: new Date() },
        });
      }
      // Na mesma transação do sucesso: um histórico que diz "deu certo"
      // sobre um evento que não concluiu seria pior que não ter histórico.
      await registrarTentativa(tx, {
        eventId, number: attempts, kind: "PROCESSING", outcome: "OK",
        durationMs: Date.now() - comecou,
      });
      return outcome;
    });
  } catch (error) {
    const permanent = error instanceof OrderError;
    await db.integrationEvent.updateMany({ where: { id: eventId, status: "PENDING" }, data: {
      status: permanent || attempts >= MAX_PROCESSING_ATTEMPTS ? "FAILED" : "PENDING",
      // Continua só o código nosso aqui: esta coluna é sobrescrita e vai
      // para a listagem. O motivo desta tentativa, com a classe do erro,
      // fica no histórico, que não se sobrescreve.
      lastError: permanent ? error.message : "PROCESSING_FAILED",
    } });
    await registrarTentativa(db, {
      eventId, number: attempts, kind: "PROCESSING",
      outcome: permanent ? "PERMANENT" : "TRANSIENT",
      durationMs: Date.now() - comecou, error,
    });
    throw error;
  }
}
