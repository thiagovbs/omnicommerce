import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";
import { canChangeStatus, isOrderStatus } from "../domain/sale-status";
import { IntegratedOrder, objectInput, OrderError, parseOrder, textInput } from "../domain/order-input";
import { serializable } from "./transactions";

export type UserActor = { userId: string; organizationId: string };

export async function assertActor(tx: Prisma.TransactionClient, actor: UserActor) {
  if (!actor.userId || !actor.organizationId || !await tx.user.findFirst({
    where: { id: actor.userId, organizationId: actor.organizationId }, select: { id: true },
  })) throw new OrderError("Não autorizado.");
}

export async function createManualOrder(db: PrismaClient, actor: UserActor, input: unknown) {
  const raw = objectInput(input);
  if (raw.organizationId !== undefined && raw.organizationId !== actor.organizationId) throw new OrderError("Organização inválida.");
  const marketplaceId = textInput(raw.marketplaceId, "Marketplace");
  const { items, ...order } = parseOrder(raw);
  return serializable(db, async (tx) => {
    await assertActor(tx, actor);
    if (!await tx.marketplace.findFirst({ where: { id: marketplaceId, organizationId: actor.organizationId, active: true } })) {
      throw new OrderError("Marketplace não encontrado ou inativo.");
    }
    const sale = await tx.sale.create({ data: {
      ...order, marketplaceId, organizationId: actor.organizationId, status: "CREATED", source: "MANUAL",
      items: { create: items },
      statusHistory: { create: { toStatus: "CREATED", source: "MANUAL", version: 0, changedById: actor.userId, occurredAt: new Date() } },
    } });
    await tx.auditLog.create({ data: {
      action: "CREATE", entity: "SALE", entityId: sale.id, userId: actor.userId, organizationId: actor.organizationId,
      details: `Venda ${sale.externalOrderId} criada manualmente.`,
      newData: { status: sale.status, gross: sale.gross.toFixed(2), net: sale.net.toFixed(2), version: 0 },
    } });
    return { id: sale.id, status: sale.status, statusVersion: sale.statusVersion };
  });
}

export async function changeManualStatus(db: PrismaClient, actor: UserActor, saleId: string, status: unknown, expectedVersion: number) {
  textInput(saleId, "Pedido");
  if (!isOrderStatus(status)) throw new OrderError("Status inválido.");
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new OrderError("Versão inválida.");
  return serializable(db, async (tx) => {
    await assertActor(tx, actor);
    const sale = await tx.sale.findFirst({ where: { id: saleId, organizationId: actor.organizationId } });
    if (!sale) throw new OrderError("Venda não encontrada.");
    if (sale.status === status) return { id: sale.id, status: sale.status, statusVersion: sale.statusVersion };
    if (sale.statusVersion !== expectedVersion) throw new OrderError("A venda foi alterada. Atualize a página e tente novamente.");
    if (!canChangeStatus(sale.status, status)) throw new OrderError("Esta mudança de status não é permitida.");
    const changed = await tx.sale.updateMany({
      where: { id: saleId, organizationId: actor.organizationId, statusVersion: expectedVersion },
      data: { status, statusVersion: { increment: 1 } },
    });
    if (changed.count !== 1) throw new OrderError("A venda foi alterada. Atualize a página e tente novamente.");
    const version = expectedVersion + 1;
    await tx.saleStatusHistory.create({ data: {
      saleId, fromStatus: sale.status, toStatus: status, source: "MANUAL", version,
      changedById: actor.userId, occurredAt: new Date(),
    } });
    await tx.auditLog.create({ data: {
      action: "UPDATE", entity: "SALE", entityId: saleId, userId: actor.userId, organizationId: actor.organizationId,
      details: `Status da venda ${sale.externalOrderId}: ${sale.status} → ${status}.`,
      oldData: { status: sale.status, version: sale.statusVersion }, newData: { status, version },
    } });
    return { id: saleId, status, statusVersion: version };
  });
}

// Called only inside the event transaction, with marketplace/organization resolved from the database.
export async function applyIntegratedOrder(tx: Prisma.TransactionClient, context: {
  marketplaceId: string; organizationId: string; eventId: string; externalEventId: string;
}, order: IntegratedOrder) {
  const existing = await tx.sale.findUnique({ where: {
    marketplaceId_externalOrderId: { marketplaceId: context.marketplaceId, externalOrderId: order.externalOrderId },
  } });
  if (existing && (existing.source !== "INTEGRATION" || existing.organizationId !== context.organizationId)) {
    throw new OrderError("Pedido existente não pertence a esta integração.");
  }
  if (existing?.externalUpdatedAt && order.externalUpdatedAt <= existing.externalUpdatedAt) return "IGNORED" as const;
  if (existing && !canChangeStatus(existing.status, order.status)) throw new OrderError("Transição externa incompatível com o estado atual.");
  const { items, ...fields } = order;
  const statusChanged = existing?.status !== order.status;
  const version = existing ? existing.statusVersion + (statusChanged ? 1 : 0) : 0;
  const data = { ...fields, lastSyncedAt: new Date(), statusVersion: version };
  const sale = existing
    ? await tx.sale.update({ where: { id: existing.id }, data: { ...data, items: { deleteMany: {}, create: items } } })
    : await tx.sale.create({ data: { ...data, marketplaceId: context.marketplaceId, organizationId: context.organizationId,
      source: "INTEGRATION", items: { create: items } } });
  if (statusChanged) await tx.saleStatusHistory.create({ data: {
    saleId: sale.id, fromStatus: existing?.status, toStatus: order.status, source: "INTEGRATION", version,
    externalEventId: context.externalEventId, externalStatus: order.externalStatus, occurredAt: order.externalUpdatedAt,
  } });
  await tx.auditLog.create({ data: {
    action: existing ? "UPDATE" : "CREATE", entity: "SALE", entityId: sale.id, actorType: "INTEGRATION",
    organizationId: context.organizationId, integrationEventId: context.eventId,
    details: `Pedido ${sale.externalOrderId} sincronizado por integração.`,
    oldData: existing ? { status: existing.status, net: existing.net.toFixed(2), version: existing.statusVersion } : Prisma.JsonNull,
    newData: { status: sale.status, net: sale.net.toFixed(2), version },
  } });
  return "PROCESSED" as const;
}
