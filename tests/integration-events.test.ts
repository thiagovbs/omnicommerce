import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { OrderError } from "../lib/domain/order-input";
import { handleMercadoLivreNotification } from "../lib/integrations/mercadolivre/webhook";
import {
  MAX_PROCESSING_ATTEMPTS, OrderSnapshotResolver, processOrderEvent, recordOrderEvent,
} from "../lib/services/integration-events";

const db = new PrismaClient();
const secret = "segredo-de-webhook-com-32-caracteres";
const fromPayload: OrderSnapshotResolver = async (event) => event.payload;

const snapshot = (id: string) => ({
  externalOrderId: id, status: "PAID", externalStatus: "paid",
  externalUpdatedAt: "2026-09-18T10:00:00Z", soldAt: "2026-09-18",
  currency: "BRL", gross: "10.00", shipping: "1.00", discount: "0.00", fees: "0.50",
  items: [{ title: "Produto", quantity: 1, unitPrice: "10.00" }],
});

const notification = (extra: Record<string, unknown> = {}) => JSON.stringify({
  topic: "orders_v2", resource: "/orders/555", user_id: 777, application_id: "app-1",
  attempts: 1, sent: "2026-09-18T11:30:00.000-03:00", ...extra,
});

const post = (body: string, path = secret) =>
  handleMercadoLivreNotification(db, new Request("https://app.invalid/api/webhooks/mercadolivre", {
    method: "POST", body,
  }), path);

test("recepção, conexão e teto de tentativas em PostgreSQL", async (t) => {
  const previousSecret = process.env.MERCADO_LIVRE_WEBHOOK_SECRET;
  const previousApp = process.env.MERCADO_LIVRE_APP_ID;
  try {
    process.env.MERCADO_LIVRE_WEBHOOK_SECRET = secret;
    delete process.env.MERCADO_LIVRE_APP_ID;

    const org = await db.organization.create({ data: { name: "Fila A" } });
    const otherOrg = await db.organization.create({ data: { name: "Fila B" } });
    const channel = await db.marketplace.create({ data: { organizationId: org.id, code: "ml_fila", name: "ML" } });
    const otherChannel = await db.marketplace.create({ data: { organizationId: otherOrg.id, code: "ml_fila", name: "ML" } });
    const connection = await db.marketplaceConnection.create({ data: {
      marketplaceId: channel.id, provider: "MERCADO_LIVRE", externalAccountId: "777",
    } });
    const inactive = await db.marketplaceConnection.create({ data: {
      marketplaceId: channel.id, provider: "SHOPEE", externalAccountId: "999", status: "INACTIVE",
    } });
    const foreign = await db.marketplaceConnection.create({ data: {
      marketplaceId: otherChannel.id, provider: "MERCADO_LIVRE", externalAccountId: "888",
    } });

    await t.test("recepção exige conexão ativa do próprio marketplace", async () => {
      const base = { externalEventId: "e1", externalOrderId: "1", payload: snapshot("1") };
      await assert.rejects(recordOrderEvent(db, { ...base, marketplaceId: channel.id, connectionId: foreign.id }), OrderError);
      await assert.rejects(recordOrderEvent(db, { ...base, marketplaceId: channel.id, connectionId: inactive.id }), OrderError);
      await assert.rejects(recordOrderEvent(db, { ...base, marketplaceId: channel.id, connectionId: "inexistente" }), OrderError);
      assert.equal(await db.integrationEvent.count({ where: { externalEventId: "e1" } }), 0);
    });

    await t.test("aviso maior que o limite não é gravado", async () => {
      await assert.rejects(recordOrderEvent(db, {
        marketplaceId: channel.id, connectionId: connection.id, externalEventId: "grande",
        externalOrderId: "2", payload: { ...snapshot("2"), notes: "x".repeat(9000) },
      }), /excede o limite/);
      assert.equal(await db.integrationEvent.count({ where: { externalEventId: "grande" } }), 0);
    });

    await t.test("webhook: segredo errado responde 404 sem tocar no banco", async () => {
      const before = await db.integrationEvent.count({ where: { marketplaceId: channel.id } });
      for (const wrong of ["", "curto", secret + "x", secret.toUpperCase()]) {
        assert.equal((await post(notification(), wrong)).status, 404);
      }
      assert.equal(await db.integrationEvent.count({ where: { marketplaceId: channel.id } }), before);
    });

    await t.test("webhook: aviso inválido responde 400", async () => {
      assert.equal((await post("não é json")).status, 400);
      assert.equal((await post(notification({ resource: "/questions/1" }))).status, 400);
      assert.equal((await post(notification({ sent: undefined }))).status, 400);
    });

    await t.test("webhook: tópico alheio, aplicação alheia e vendedor desconhecido são confirmados e descartados", async () => {
      const before = await db.integrationEvent.count({ where: { marketplaceId: channel.id } });
      for (const body of [notification({ topic: "questions" }), notification({ user_id: 31415 })]) {
        const response = await post(body);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: "ignored" });
      }
      process.env.MERCADO_LIVRE_APP_ID = "app-esperado";
      assert.deepEqual(await (await post(notification())).json(), { status: "ignored" });
      delete process.env.MERCADO_LIVRE_APP_ID;
      assert.equal(await db.integrationEvent.count({ where: { marketplaceId: channel.id } }), before);
    });

    await t.test("webhook: aviso válido enfileira uma vez, com conexão e pendência de publicação", async () => {
      assert.deepEqual(await (await post(notification())).json(), { status: "queued" });
      // Reenvio do mesmo aviso não cria segundo evento nem segunda publicação.
      assert.deepEqual(await (await post(notification({ attempts: 3 }))).json(), { status: "queued" });
      const events = await db.integrationEvent.findMany({
        where: { marketplaceId: channel.id, externalOrderId: "555" }, include: { outbox: true },
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].connectionId, connection.id);
      assert.equal(events[0].status, "PENDING");
      assert.equal(events[0].outbox?.status, "PENDING");
      // O payload guardado é o aviso como chegou, não um pedido: quem normaliza é o job.
      const payload = events[0].payload as Record<string, unknown>;
      assert.deepEqual(Object.keys(payload).sort(),
        ["application_id", "attempts", "resource", "sent", "topic", "user_id"]);
      assert.equal(payload.resource, "/orders/555");
      assert.equal(payload.user_id, 777);
    });

    await t.test("processamento marca a conexão como sincronizada", async () => {
      const event = await recordOrderEvent(db, {
        marketplaceId: channel.id, connectionId: connection.id, externalEventId: "sync",
        externalOrderId: "sync-1", payload: snapshot("sync-1"),
      });
      assert.equal(await processOrderEvent(db, event.id, fromPayload), "PROCESSED");
      const synced = await db.marketplaceConnection.findUniqueOrThrow({ where: { id: connection.id } });
      assert(synced.lastSyncedAt, "lastSyncedAt deveria estar preenchido");
      const sale = await db.sale.findFirstOrThrow({ where: { externalOrderId: "sync-1" } });
      assert.equal(sale.organizationId, org.id);
    });

    await t.test("falha permanente do resolver encerra o evento na primeira tentativa", async () => {
      const event = await recordOrderEvent(db, {
        marketplaceId: channel.id, connectionId: connection.id, externalEventId: "permanente",
        externalOrderId: "perm-1", payload: snapshot("perm-1"),
      });
      await assert.rejects(processOrderEvent(db, event.id, async () => {
        throw new OrderError("Status desconhecido do provedor.");
      }));
      const failed = await db.integrationEvent.findUniqueOrThrow({ where: { id: event.id } });
      assert.equal(failed.status, "FAILED");
      assert.equal(failed.attempts, 1);
      assert.equal(failed.lastError, "Status desconhecido do provedor.");
    });

    await t.test("falha transitória repete até o teto e então para de ser reprocessada", async () => {
      const event = await recordOrderEvent(db, {
        marketplaceId: channel.id, connectionId: connection.id, externalEventId: "transitoria",
        externalOrderId: "trans-1", payload: snapshot("trans-1"),
      });
      const failing: OrderSnapshotResolver = async () => { throw new Error("segredo da rede não deve vazar"); };
      for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt++) {
        await assert.rejects(processOrderEvent(db, event.id, failing));
        const current = await db.integrationEvent.findUniqueOrThrow({ where: { id: event.id } });
        assert.equal(current.attempts, attempt);
        assert.equal(current.status, attempt < MAX_PROCESSING_ATTEMPTS ? "PENDING" : "FAILED");
        // A mensagem do erro interno nunca é persistida.
        assert.equal(current.lastError, "PROCESSING_FAILED");
      }
      // Esgotado o teto, uma nova entrega não refaz o trabalho nem incrementa tentativas.
      assert.equal(await processOrderEvent(db, event.id, failing), "FAILED");
      assert.equal((await db.integrationEvent.findUniqueOrThrow({ where: { id: event.id } })).attempts, MAX_PROCESSING_ATTEMPTS);
      assert.equal(await db.sale.count({ where: { externalOrderId: "trans-1" } }), 0);
    });
  } finally {
    if (previousSecret === undefined) delete process.env.MERCADO_LIVRE_WEBHOOK_SECRET;
    else process.env.MERCADO_LIVRE_WEBHOOK_SECRET = previousSecret;
    if (previousApp === undefined) delete process.env.MERCADO_LIVRE_APP_ID;
    else process.env.MERCADO_LIVRE_APP_ID = previousApp;
    await db.$disconnect();
  }
});
