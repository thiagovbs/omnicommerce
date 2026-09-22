import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { parseOrder, parseIntegratedOrder } from "../lib/domain/order-input";
import { createManualOrder, changeManualStatus } from "../lib/services/sales";
import { OrderSnapshotResolver, recordOrderEvent, processOrderEvent } from "../lib/services/integration-events";
import { dispatchOutbox, requeueOrderEvent } from "../lib/services/outbox";

const db = new PrismaClient();
// O payload gravado destes testes já é o snapshot, então o resolver apenas o devolve:
// nenhuma chamada de rede participa dos testes.
const fromPayload: OrderSnapshotResolver = async (event) => event.payload;
const runEvent = (eventId: string) => processOrderEvent(db, eventId, fromPayload);
const recordChannelEvent = (
  marketplaceId: string, externalEventId: string,
  payload: Record<string, unknown> & { externalOrderId: string },
) => recordOrderEvent(db, {
  marketplaceId, externalEventId, externalOrderId: payload.externalOrderId, payload,
});
const snapshot = (id: string, status = "PAID", time = "2026-09-18T10:00:00Z") => ({
  externalOrderId: id, status, externalStatus: status.toLowerCase(), externalUpdatedAt: time,
  soldAt: "2026-09-18", currency: "BRL", gross: "0.30", shipping: "0.10", discount: "0.00", fees: "0.01",
  items: [{ title: "Produto", quantity: 3, unitPrice: "0.10" }],
});

test("pedidos, status e eventos em PostgreSQL", async (t) => {
  try {
    const org = await db.organization.create({ data: { name: "Test A" } });
    const otherOrg = await db.organization.create({ data: { name: "Test B" } });
    const user = await db.user.create({ data: { organizationId: org.id, name: "Admin", email: "admin@test.invalid", role: "ADMIN" } });
    const outsider = await db.user.create({ data: { organizationId: otherOrg.id, name: "Other", email: "other@test.invalid" } });
    const actor = { userId: user.id, organizationId: org.id };
    const otherActor = { userId: outsider.id, organizationId: otherOrg.id };
    const channel = await db.marketplace.create({ data: { organizationId: org.id, code: "mercado_livre", name: "ML" } });
    const otherChannel = await db.marketplace.create({ data: { organizationId: otherOrg.id, code: "mercado_livre", name: "ML" } });
    const manual = (id: string) => ({ ...snapshot(id), marketplaceId: channel.id });

    await t.test("validação de valores, itens, datas e snapshots incompletos", () => {
      assert.equal(parseOrder(snapshot("decimal")).net.toFixed(2), "0.39");
      for (const patch of [
        { items: [] }, { gross: "0.31" }, { fees: "-1" }, { fees: "1.001" },
        { fees: Number.NaN }, { soldAt: "2026-02-30" }, { currency: "INVALID" },
        { items: [{ title: "Produto", quantity: 0, unitPrice: "1.00" }] },
        { items: [{ title: "Produto", quantity: "2.5", unitPrice: "1.00" }] },
      ]) assert.throws(() => parseOrder({ ...snapshot("bad"), ...patch }));
      assert.throws(() => parseIntegratedOrder({ ...snapshot("bad"), fees: undefined }));
      assert.throws(() => parseIntegratedOrder({ ...snapshot("bad"), externalUpdatedAt: "2026-09-18" }));
    });

    const sale = await createManualOrder(db, actor, manual("manual"));
    await t.test("criação grava valores decimais, histórico inicial e auditoria", async () => {
      const order = await db.sale.findUniqueOrThrow({ where: { id: sale.id }, include: { items: true, statusHistory: true } });
      assert.equal(order.gross.toFixed(2), "0.30");
      assert.equal(order.net.toFixed(2), "0.39");
      assert.equal(order.status, "CREATED");
      assert.equal(order.statusHistory.length, 1);
      assert.equal(order.statusHistory[0].changedById, user.id);
      assert.equal(await db.auditLog.count({ where: { entityId: sale.id } }), 1);
    });

    await t.test("rejeita acesso e vínculo de outra organização", async () => {
      await assert.rejects(createManualOrder(db, actor, { ...manual("bad-org"), organizationId: otherOrg.id }));
      await assert.rejects(createManualOrder(db, actor, { ...manual("bad-market"), marketplaceId: otherChannel.id }));
      await assert.rejects(createManualOrder(db, { ...actor, userId: outsider.id }, manual("bad-actor")));
      await assert.rejects(changeManualStatus(db, otherActor, sale.id, "PAID", 0));
      await assert.rejects(changeManualStatus(db, actor, sale.id, "UNRECOGNIZED", 0));
    });

    await t.test("mudança é atômica, idempotente e rejeita versão antiga/regressão", async () => {
      await changeManualStatus(db, actor, sale.id, "PAID", 0);
      await changeManualStatus(db, actor, sale.id, "PAID", 0);
      assert.equal(await db.saleStatusHistory.count({ where: { saleId: sale.id } }), 2);
      assert.equal(await db.auditLog.count({ where: { entityId: sale.id } }), 2);
      await assert.rejects(changeManualStatus(db, actor, sale.id, "SHIPPED", 0));
      await assert.rejects(changeManualStatus(db, actor, sale.id, "CREATED", 1));
      await changeManualStatus(db, actor, sale.id, "DELIVERED", 1);
      await changeManualStatus(db, actor, sale.id, "REFUNDED", 2);
      await assert.rejects(changeManualStatus(db, actor, sale.id, "PAID", 3));
    });

    await t.test("duas mudanças concorrentes não sobrescrevem a mesma versão", async () => {
      const concurrent = await createManualOrder(db, actor, manual("concurrent"));
      const results = await Promise.allSettled([
        changeManualStatus(db, actor, concurrent.id, "PAID", 0),
        changeManualStatus(db, actor, concurrent.id, "SHIPPED", 0),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(await db.saleStatusHistory.count({ where: { saleId: concurrent.id } }), 2);
    });

    await t.test("falha na auditoria desfaz pedido, itens e histórico", async () => {
      await db.$executeRawUnsafe(`CREATE FUNCTION test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.details LIKE '%ROLLBACK%' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER fail_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION test_fail_audit()`);
      try {
        await assert.rejects(createManualOrder(db, actor, manual("ROLLBACK")));
        assert.equal(await db.sale.count({ where: { externalOrderId: "ROLLBACK" } }), 0);
        const event = await recordChannelEvent(channel.id, "rollback-event", snapshot("ROLLBACK-event"));
        await assert.rejects(runEvent(event.id));
        assert.equal(await db.sale.count({ where: { externalOrderId: "ROLLBACK-event" } }), 0);
        assert.equal((await db.integrationEvent.findUniqueOrThrow({ where: { id: event.id } })).status, "PENDING");
      } finally {
        await db.$executeRawUnsafe('DROP TRIGGER fail_audit ON "AuditLog"');
        await db.$executeRawUnsafe('DROP FUNCTION test_fail_audit()');
      }
    });

    await t.test("recepção duplicada e processamento paralelo geram uma venda e uma auditoria", async () => {
      const events = await Promise.all([
        recordChannelEvent(channel.id, "ml:1", snapshot("imported")),
        recordChannelEvent(channel.id, "ml:1", snapshot("imported")),
      ]);
      assert.equal(events[0].id, events[1].id);
      assert.equal(await db.outboxMessage.count({ where: { eventId: events[0].id } }), 1);
      await Promise.all(events.map((event) => runEvent(event.id)));
      const order = await db.sale.findFirstOrThrow({ where: { externalOrderId: "imported" } });
      assert.equal(order.source, "INTEGRATION");
      assert.equal(order.organizationId, org.id);
      assert.equal(await db.saleStatusHistory.count({ where: { saleId: order.id } }), 1);
      const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: order.id } });
      assert.equal(audit.userId, null);
      assert.equal(audit.actorType, "INTEGRATION");
    });

    await t.test("evento atrasado é ignorado; atualização financeira sem transição não duplica histórico", async () => {
      const old = await recordChannelEvent(channel.id, "ml:old", snapshot("imported", "CREATED", "2026-09-18T09:00:00Z"));
      assert.equal(await runEvent(old.id), "IGNORED");
      const same = await recordChannelEvent(channel.id, "ml:same", { ...snapshot("imported", "PAID", "2026-09-18T11:00:00Z"), fees: "0.02" });
      assert.equal(await runEvent(same.id), "PROCESSED");
      const order = await db.sale.findFirstOrThrow({ where: { externalOrderId: "imported" } });
      assert.equal(order.net.toFixed(2), "0.38");
      assert.equal(order.statusVersion, 0);
      assert.equal(await db.saleStatusHistory.count({ where: { saleId: order.id } }), 1);
    });

    await t.test("eventos concorrentes convergem ao snapshot mais recente", async () => {
      const events = await Promise.all([
        recordChannelEvent(channel.id, "ml:shipped", snapshot("imported", "SHIPPED", "2026-09-18T12:00:00Z")),
        recordChannelEvent(channel.id, "ml:delivered", snapshot("imported", "DELIVERED", "2026-09-18T13:00:00Z")),
      ]);
      await Promise.all(events.map((event) => runEvent(event.id)));
      const order = await db.sale.findFirstOrThrow({ where: { externalOrderId: "imported" } });
      assert.equal(order.status, "DELIVERED");
      assert.equal(order.externalUpdatedAt?.toISOString(), "2026-09-18T13:00:00.000Z");
    });

    await t.test("importação não sobrescreve pedido manual e reprocessamento exige administrador da organização", async () => {
      const event = await recordChannelEvent(channel.id, "collision", snapshot("manual"));
      await assert.rejects(runEvent(event.id));
      assert.equal((await db.integrationEvent.findUniqueOrThrow({ where: { id: event.id } })).status, "FAILED");
      await assert.rejects(requeueOrderEvent(db, otherActor, event.id));
      await requeueOrderEvent(db, actor, event.id);
      assert.equal((await db.integrationEvent.findUniqueOrThrow({ where: { id: event.id } })).status, "PENDING");
    });

    await t.test("outbox recupera falhas, protege publicação concorrente e retoma lease expirado", async () => {
      // Limitado a ESTA organização, do começo ao fim. O banco de teste é
      // compartilhado com as outras suítes, que enfileiram avisos enquanto
      // isto roda: sem o filtro, "exatamente um pendente" era uma corrida --
      // e o `updateMany` sem `where`, que zerava a fila de todo mundo, era a
      // outra metade do problema.
      await db.outboxMessage.updateMany({
        where: { event: { marketplace: { organizationId: org.id } } },
        data: { status: "PUBLISHED" },
      });
      const event = await recordChannelEvent(channel.id, "outbox", snapshot("outbox"));
      const failure = await dispatchOutbox(
        db, async () => { throw new Error("network secret must not be saved"); }, 20, org.id);
      assert.equal(failure.failed, 1);
      const pending = await db.outboxMessage.findUniqueOrThrow({ where: { eventId: event.id } });
      assert.equal(pending.status, "PENDING");
      assert.equal(pending.lastError, "PUBLISH_FAILED");
      assert(pending.availableAt > new Date());
      await db.outboxMessage.update({ where: { eventId: event.id }, data: { availableAt: new Date(0), leaseUntil: new Date(0), leaseToken: "expired" } });
      let deliveries = 0;
      await Promise.all([1, 2].map(() => dispatchOutbox(db, async (message) => {
        assert.equal(message.eventId, event.id);
        // O QStash recusa o id de deduplicação com dois-pontos; o dublê imita a
        // regra para a publicação real não quebrar sem ninguém notar.
        assert.match(message.deduplicationId, /^[A-Za-z0-9_.-]{1,128}$/);
        deliveries++;
      }, 20, org.id)));
      assert.equal(deliveries, 1);
      assert.equal((await db.outboxMessage.findUniqueOrThrow({ where: { eventId: event.id } })).status, "PUBLISHED");
    });
  } finally { await db.$disconnect(); }
});
