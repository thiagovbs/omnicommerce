import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { OrderError } from "../lib/domain/order-input";
import {
  janelaDe, JANELA_PADRAO_MS, ListarAlterados, reconcileAll, reconcileConnection,
  sincronizarAgora,
} from "../lib/services/reconciliation";
import {
  processOrderEvent, OrderSnapshotResolver, recordOrderEvent,
} from "../lib/services/integration-events";

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

    await t.test("janela cai no padrão sem conciliação e usa a última com folga", () => {
      const agora = new Date("2026-09-19T12:00:00Z");
      const semMarca = janelaDe({ ...conexao, lastReconciledAt: null }, agora);
      assert.equal(agora.getTime() - semMarca.getTime(), JANELA_PADRAO_MS);

      const conciliada = new Date("2026-09-19T11:00:00Z");
      const comMarca = janelaDe({ ...conexao, lastReconciledAt: conciliada }, agora);
      // Volta antes da última conciliação, para não perder o que mudou
      // enquanto a rodada anterior corria.
      assert(comMarca < conciliada);
    });

    await t.test("aviso entregue agora não encolhe a janela da conciliação", () => {
      // Regressão: com a janela saindo de `lastSyncedAt`, um aviso entregue
      // às 11h faria a rodada olhar só a partir das 10h, e o pedido das 09h
      // cujo aviso se perdeu nunca mais seria repescado.
      const agora = new Date("2026-09-19T12:00:00Z");
      const janela = janelaDe({
        ...conexao,
        lastReconciledAt: new Date("2026-09-19T08:00:00Z"),
        lastSyncedAt: new Date("2026-09-19T11:00:00Z"),
      }, agora);
      assert(janela < new Date("2026-09-19T09:00:00Z"));
    });

    await t.test("pedido que nunca chegou é enfileirado e vira venda", async () => {
      const alterado = new Date("2026-09-19T10:00:00Z");
      const listar: ListarAlterados = async () => [{ externalOrderId: "perdido-1", updatedAt: alterado }];

      const antes = new Date();
      const resultado = await reconcileConnection(db, conexao, listar);
      assert.deepEqual(resultado, { verificados: 1, enfileirados: 1, emDia: 0 });

      // A marca avança só depois de enfileirar, e não passa do início da rodada.
      const marcada = await db.marketplaceConnection.findUniqueOrThrow({ where: { id: conexao.id } });
      assert(marcada.lastReconciledAt !== null);
      assert(marcada.lastReconciledAt >= antes);

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

    await t.test("falha ao listar deixa a marca onde estava", async () => {
      const marcaAnterior = (await db.marketplaceConnection.findUniqueOrThrow({
        where: { id: conexao.id },
      })).lastReconciledAt;

      await assert.rejects(
        reconcileConnection(db, conexao, async () => { throw new OrderError("provedor fora do ar"); }),
      );

      const depois = (await db.marketplaceConnection.findUniqueOrThrow({
        where: { id: conexao.id },
      })).lastReconciledAt;
      // Senão a janela pularia adiante sem ter varrido nada.
      assert.deepEqual(depois, marcaAnterior);
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

    await t.test("sincronizar agora concilia e esvazia a fila, só da organização", async () => {
      // O botão da tela. Faz as duas metades no mesmo clique: pergunta ao
      // provedor o que mudou e publica o que enfileirou -- porque esperar a
      // conciliação da hora cheia e depois a rodada do despachante é a pior
      // resposta para quem acabou de ver que a venda não entrou.
      const admin = await db.user.create({ data: {
        organizationId: org.id, email: `sync-${Date.now()}@local.test`,
        name: "Admin", passwordHash: "x", role: "ADMIN",
      } });
      const ator = { userId: admin.id, organizationId: org.id };

      // Outra organização, com aviso pendente na fila: nada dela pode sair
      // com a sessão de quem apertou o botão.
      const outraOrg = await db.organization.create({ data: { name: `Alheia ${Date.now()}` } });
      const outroCanal = await db.marketplace.create({
        data: { organizationId: outraOrg.id, code: "sebo", name: "Sebo alheio" },
      });
      const alheio = await recordOrderEvent(db, {
        marketplaceId: outroCanal.id, externalEventId: `alheio-${Date.now()}`,
        externalOrderId: "nao-e-meu", payload: {},
      });

      const publicados: string[] = [];
      const publish = async ({ eventId }: { eventId: string }) => { publicados.push(eventId); };
      const listar: ListarAlterados = async (connection) => (connection.id === conexao.id
        ? [{ externalOrderId: "pelo-botao", updatedAt: new Date("2026-09-19T22:00:00Z") }]
        : []);

      const resultado = await sincronizarAgora(db, ator, listar, publish, {
        connectionId: conexao.id,
      });
      assert.equal(resultado.conexoes, 1);
      assert.equal(resultado.enfileirados, 1);
      // Publicou o que acabou de enfileirar, sem esperar rodada nenhuma.
      assert.ok(resultado.publicados >= 1);

      const evento = await db.integrationEvent.findFirstOrThrow({
        where: { externalOrderId: "pelo-botao" }, include: { outbox: true },
      });
      assert.equal(evento.outbox?.status, "PUBLISHED");
      assert.ok(publicados.includes(evento.id));
      // A fila da outra organização não foi tocada.
      assert.equal(publicados.includes(alheio.id), false);
      assert.equal(
        (await db.outboxMessage.findUniqueOrThrow({ where: { eventId: alheio.id } })).status,
        "PENDING");

      // Fica registrado quem mandou sincronizar.
      const registro = await db.auditLog.findFirst({
        where: { organizationId: org.id, action: "SYNC" }, orderBy: { createdAt: "desc" },
      });
      assert.ok(registro?.details?.includes("Sincronização manual"));
    });

    await t.test("sincronizar não alcança conexão de outra organização", async () => {
      const admin = await db.user.create({ data: {
        organizationId: org.id, email: `sync2-${Date.now()}@local.test`,
        name: "Admin", passwordHash: "x", role: "ADMIN",
      } });
      const outraOrg = await db.organization.create({ data: { name: `Alheia2 ${Date.now()}` } });
      const outroCanal = await db.marketplace.create({
        data: { organizationId: outraOrg.id, code: "sebo", name: "Sebo alheio 2" },
      });
      const conexaoAlheia = await db.marketplaceConnection.create({
        data: { marketplaceId: outroCanal.id, provider: "SEBO_ONLINE", externalAccountId: `alheia-${Date.now()}` },
      });
      // Id de conexão alheia não encontra nada: a organização entra na
      // consulta, e não numa conferência depois.
      await assert.rejects(
        sincronizarAgora(db, { userId: admin.id, organizationId: org.id },
          async () => [], async () => {}, { connectionId: conexaoAlheia.id }),
        (e: Error) => e instanceof OrderError && /não encontrada/.test(e.message));
    });

    await t.test("quem não é administrador não sincroniza", async () => {
      const operador = await db.user.create({ data: {
        organizationId: org.id, email: `op-${Date.now()}@local.test`,
        name: "Operador", passwordHash: "x", role: "OPERATOR",
      } });
      await assert.rejects(
        sincronizarAgora(db, { userId: operador.id, organizationId: org.id },
          async () => [], async () => {}),
        (e: Error) => e instanceof OrderError && /administradores/.test(e.message));
    });

    await t.test("conexão inativa fica de fora da rodada", async () => {
      await db.marketplaceConnection.update({
        where: { id: conexao.id }, data: { status: "INACTIVE" },
      });
      try {
        // Pelas conexões que a rodada PERGUNTOU, e não por uma contagem global:
        // o banco de teste é compartilhado com as outras suítes, que criam e
        // apagam conexão enquanto esta roda. Contar duas vezes em momentos
        // diferentes comparava números de mundos diferentes.
        const perguntadas: string[] = [];
        await reconcileAll(db, async (connection) => { perguntadas.push(connection.id); return []; });
        assert.equal(perguntadas.includes(conexao.id), false,
          "conexão inativa não pode entrar na rodada");
      } finally {
        await db.marketplaceConnection.update({
          where: { id: conexao.id }, data: { status: "ACTIVE" },
        });
      }
    });
  } finally { await db.$disconnect(); }
});
