import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { OrderError } from "../lib/domain/order-input";
import {
  janelaDe, JANELA_PADRAO_MS, ListarAlterados, reconcileAll, reconcileConnection,
} from "../lib/services/reconciliation";
import { processOrderEvent, OrderSnapshotResolver } from "../lib/services/integration-events";

const db = new PrismaClient();

const snapshot = (id: string, atualizado: string) => ({
  externalOrderId: id, status: "PAID", externalStatus: "PAID",
  externalUpdatedAt: atualizado, soldAt: "2026-09-18",
  currency: "BRL", gross: "10.00", shipping: "0.00", discount: "0.00", fees: "0.00",
  items: [{ title: "Produto", quantity: 1, unitPrice: "10.00" }],
});

// O resolver devolve o snapshot que o teste combinou para aquele pedido.
const resolverDe = (porPedido: Record<string, string>): OrderSnapshotResolver =>
  async (evento) => snapshot(evento.externalOrderId, porPedido[evento.externalOrderId]);

test("conciliação periódica em PostgreSQL", async (t) => {
  try {
    const org = await db.organization.create({ data: { name: "Conciliação" } });
    const canal = await db.marketplace.create({
      data: { organizationId: org.id, code: "sebo", name: "Sebo" },
    });
    const conexao = await db.marketplaceConnection.create({
      data: { marketplaceId: canal.id, provider: "SEBO_ONLINE", externalAccountId: "loja-1" },
    });

    await t.test("janela cai no padrão sem sincronização e usa a última com folga", () => {
      const agora = new Date("2026-09-19T12:00:00Z");
      const semSync = janelaDe({ ...conexao, lastSyncedAt: null }, agora);
      assert.equal(agora.getTime() - semSync.getTime(), JANELA_PADRAO_MS);

      const sincronizada = new Date("2026-09-19T11:00:00Z");
      const comSync = janelaDe({ ...conexao, lastSyncedAt: sincronizada }, agora);
      // Volta antes da última sincronização, para não perder o que mudou
      // enquanto a rodada anterior corria.
      assert(comSync < sincronizada);
    });

    await t.test("pedido que nunca chegou é enfileirado e vira venda", async () => {
      const alterado = new Date("2026-09-19T10:00:00Z");
      const listar: ListarAlterados = async () => [{ externalOrderId: "perdido-1", updatedAt: alterado }];

      const resultado = await reconcileConnection(db, conexao, listar);
      assert.deepEqual(resultado, { verificados: 1, enfileirados: 1, emDia: 0 });

      const evento = await db.integrationEvent.findFirstOrThrow({
        where: { externalOrderId: "perdido-1" }, include: { outbox: true },
      });
      assert.equal(evento.connectionId, conexao.id);
      assert.equal(evento.outbox?.status, "PENDING");
      // O payload diz de onde veio: conciliação não é aviso do provedor.
      assert.equal((evento.payload as Record<string, unknown>).origem, "conciliacao");

      assert.equal(
        await processOrderEvent(db, evento.id, resolverDe({ "perdido-1": alterado.toISOString() })),
        "PROCESSED",
      );
      const venda = await db.sale.findFirstOrThrow({ where: { externalOrderId: "perdido-1" } });
      assert.equal(venda.organizationId, org.id);
      assert.equal(venda.source, "INTEGRATION");
    });

    await t.test("rodar de novo sobre o mesmo pedido não enfileira nada", async () => {
      const listar: ListarAlterados = async () => [
        { externalOrderId: "perdido-1", updatedAt: new Date("2026-09-19T10:00:00Z") },
      ];
      const resultado = await reconcileConnection(db, conexao, listar);
      assert.deepEqual(resultado, { verificados: 1, enfileirados: 0, emDia: 1 });
      assert.equal(await db.integrationEvent.count({ where: { externalOrderId: "perdido-1" } }), 1);
    });

    await t.test("versão mais nova no provedor é enfileirada", async () => {
      const maisNovo = new Date("2026-09-19T18:00:00Z");
      const listar: ListarAlterados = async () => [{ externalOrderId: "perdido-1", updatedAt: maisNovo }];
      assert.equal((await reconcileConnection(db, conexao, listar)).enfileirados, 1);
      // Identidade inclui o carimbo, então é evento novo e não colide com o anterior.
      assert.equal(await db.integrationEvent.count({ where: { externalOrderId: "perdido-1" } }), 2);
    });

    await t.test("conciliar duas vezes a mesma versão não duplica o evento", async () => {
      const carimbo = new Date("2026-09-19T20:00:00Z");
      const listar: ListarAlterados = async () => [{ externalOrderId: "repetido", updatedAt: carimbo }];
      await reconcileConnection(db, conexao, listar);
      await reconcileConnection(db, conexao, listar);
      assert.equal(await db.integrationEvent.count({ where: { externalOrderId: "repetido" } }), 1);
    });

    await t.test("uma conexão com problema não impede as outras", async () => {
      const outroCanal = await db.marketplace.create({
        data: { organizationId: org.id, code: "mercado_livre", name: "ML" },
      });
      await db.marketplaceConnection.create({
        data: { marketplaceId: outroCanal.id, provider: "MERCADO_LIVRE", externalAccountId: "conta-ml" },
      });

      // A rodada é do sistema inteiro e o banco de teste é compartilhado entre
      // as suítes: o dublê só responde às conexões deste teste.
      const listar: ListarAlterados = async (connection) => {
        if (connection.externalAccountId === "conta-ml") {
          throw new OrderError("Conciliação do Mercado Livre ainda não implementada.");
        }
        if (connection.id !== conexao.id) return [];
        return [{ externalOrderId: "apos-falha", updatedAt: new Date("2026-09-19T21:00:00Z") }];
      };

      const resultado = await reconcileAll(db, listar);
      assert.equal(resultado.enfileirados, 1);
      // A falha de uma conexão é relatada sem interromper as demais.
      assert.equal(resultado.falhas.length, 1);
      assert.match(resultado.falhas[0], /MERCADO_LIVRE\/conta-ml/);
      assert.match(resultado.falhas[0], /não implementada/);
      assert.equal(await db.integrationEvent.count({ where: { externalOrderId: "apos-falha" } }), 1);
    });

    await t.test("conexão inativa fica de fora da rodada", async () => {
      await db.marketplaceConnection.update({
        where: { id: conexao.id }, data: { status: "INACTIVE" },
      });
      try {
        const resultado = await reconcileAll(db, async () => []);
        const ativas = await db.marketplaceConnection.count({
          where: { status: "ACTIVE", marketplace: { active: true } },
        });
        assert.equal(resultado.conexoes, ativas);
      } finally {
        await db.marketplaceConnection.update({
          where: { id: conexao.id }, data: { status: "ACTIVE" },
        });
      }
    });
  } finally { await db.$disconnect(); }
});
