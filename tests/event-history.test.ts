import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { OrderError } from "../lib/domain/order-input";
import { ProviderTransientError } from "../lib/integrations/mercadolivre/client";
import { eventHistory, registrarTentativa } from "../lib/services/event-history";
import { processOrderEvent, recordOrderEvent } from "../lib/services/integration-events";

/**
 * Histórico por tentativa.
 *
 * O defeito que ele corrige: `IntegrationEvent.lastError` guarda só a ÚLTIMA
 * falha e a sobrescreve. Um evento que falhou por recusa do provedor e depois
 * por timeout mostrava apenas o timeout -- e falha transitória nem isso, porque
 * gravava o código genérico `PROCESSING_FAILED`.
 *
 * O que este arquivo protege, em ordem:
 *
 * 1. **Mensagem de terceiro não é registrada.** Ela pode carregar cabeçalho ou
 *    credencial, e credencial que vazou precisa ser trocada no provedor. É o
 *    único item aqui sem correção depois do fato.
 * 2. **Uma linha por tentativa, que não se sobrescreve.** É a razão de existir.
 * 3. **O histórico não derruba o processamento.** Ele serve para explicar o que
 *    aconteceu; seria absurdo impedir que acontecesse.
 * 4. **Uma organização não lê o evento da outra.**
 */

const snapshot = (id: string) => ({
  externalOrderId: id, status: "PAID", externalStatus: "paid",
  externalUpdatedAt: "2026-09-18T10:00:00Z", soldAt: "2026-09-18",
  currency: "BRL", gross: "10.00", shipping: "0.00", discount: "0.00", fees: "0.00",
  items: [{ title: "Produto", quantity: 1, unitPrice: "10.00" }],
});

test("histórico de tentativas sem banco", async (t) => {
  await t.test("falha ao gravar histórico não derruba o processamento", async () => {
    const dbQuebrado = {
      integrationEventAttempt: {
        create: async () => { throw new Error("banco fora do ar"); },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    // Sem rejeitar: o histórico explica o que aconteceu, não decide se acontece.
    await registrarTentativa(dbQuebrado, {
      eventId: "evt-1", number: 1, kind: "PROCESSING", outcome: "OK",
    });
  });

  await t.test("mensagem nossa é registrada; a de terceiro, não", async () => {
    const gravadas: Record<string, unknown>[] = [];
    const db = {
      integrationEventAttempt: {
        create: async (args: { data: Record<string, unknown> }) => { gravadas.push(args.data); },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await registrarTentativa(db, {
      eventId: "e", number: 1, kind: "PROCESSING", outcome: "PERMANENT",
      error: new OrderError("Marketplace inativo."),
    });
    await registrarTentativa(db, {
      eventId: "e", number: 2, kind: "PROCESSING", outcome: "TRANSIENT",
      error: new ProviderTransientError("SEBO_UNAVAILABLE"),
    });
    // Erro de fora: a mensagem pode trazer URL assinada, cabeçalho ou token.
    await registrarTentativa(db, {
      eventId: "e", number: 3, kind: "DELIVERY", outcome: "TRANSIENT",
      error: new TypeError("fetch failed para https://api.exemplo.com?token=SEGREDO"),
    });

    assert.equal(gravadas[0].error, "Marketplace inativo.");
    assert.equal(gravadas[0].errorClass, "OrderError");
    assert.equal(gravadas[1].error, "SEBO_UNAVAILABLE", "código nosso pode aparecer");
    assert.equal(gravadas[2].error, null, "mensagem de fora não entra");
    assert.equal(gravadas[2].errorClass, "TypeError",
      "a classe entra: é ela que separa rede de defeito nosso");
  });

  await t.test("mensagem longa é truncada: o histórico é para ler", async () => {
    const gravadas: Record<string, unknown>[] = [];
    const db = {
      integrationEventAttempt: {
        create: async (args: { data: Record<string, unknown> }) => { gravadas.push(args.data); },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await registrarTentativa(db, {
      eventId: "e", number: 1, kind: "PROCESSING", outcome: "PERMANENT",
      error: new OrderError("x".repeat(3000)),
    });
    assert.equal((gravadas[0].error as string).length, 500);
  });
});

test("histórico de tentativas em PostgreSQL", async (t) => {
  const db = new PrismaClient();
  try {
    const org = await db.organization.create({ data: { name: "Histórico A" } });
    const admin = await db.user.create({ data: {
      organizationId: org.id, email: `hist-a-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const ator = { userId: admin.id, organizationId: org.id };
    const canal = await db.marketplace.create({ data: {
      organizationId: org.id, code: "mercado_livre", name: "ML", provider: "MERCADO_LIVRE",
    } });
    const conexao = await db.marketplaceConnection.create({ data: {
      marketplaceId: canal.id, provider: "MERCADO_LIVRE",
      externalAccountId: `hist-${Date.now()}`,
    } });

    const novoEvento = async (sufixo: string) => {
      const { id } = await recordOrderEvent(db, {
        marketplaceId: canal.id, connectionId: conexao.id,
        externalEventId: `hist:${sufixo}:${Date.now()}`,
        externalOrderId: `ord-${sufixo}`, payload: snapshot(`ord-${sufixo}`),
      });
      return id;
    };

    await t.test("duas falhas por motivos diferentes deixam DOIS registros", async () => {
      const eventoId = await novoEvento("duas");
      // Transitória: o evento continua pendente e será tentado de novo.
      await assert.rejects(processOrderEvent(db, eventoId, async () => {
        throw new ProviderTransientError("ML_UNAVAILABLE");
      }));
      // Permanente: para por aqui.
      await assert.rejects(processOrderEvent(db, eventoId, async () => {
        throw new OrderError("Pedido sem itens.");
      }));

      const historico = await eventHistory(db, ator, eventoId);
      assert.equal(historico.attemptLog.length, 2);
      const [primeira, segunda] = historico.attemptLog;
      assert.equal(primeira.number, 1);
      assert.equal(primeira.outcome, "TRANSIENT");
      assert.equal(primeira.errorClass, "ProviderTransientError");
      assert.equal(primeira.error, "ML_UNAVAILABLE");
      assert.equal(segunda.outcome, "PERMANENT");
      assert.equal(segunda.error, "Pedido sem itens.");
      assert.ok((segunda.durationMs ?? -1) >= 0, "a duração separa timeout de recusa");

      // A coluna do evento continua com a última: é o que a listagem mostra, e
      // é justamente por ela sobrescrever que o histórico precisa existir.
      assert.equal(historico.lastError, "Pedido sem itens.");
      assert.equal(historico.status, "FAILED");
    });

    await t.test("sucesso é registrado, e na mesma transação do resultado", async () => {
      const eventoId = await novoEvento("ok");
      await processOrderEvent(db, eventoId, async (evento) => snapshot(evento.externalOrderId));

      const historico = await eventHistory(db, ator, eventoId);
      assert.equal(historico.status, "PROCESSED");
      assert.equal(historico.attemptLog.length, 1);
      assert.equal(historico.attemptLog[0].outcome, "OK");
      assert.equal(historico.attemptLog[0].error, null);
      // Evento processado não pode ter histórico dizendo que falhou, nem o
      // contrário: por isso o registro do sucesso vai na transação dele.
      assert.equal(historico.processedAt !== null, true);
    });

    await t.test("a tela recebe também a auditoria e o aviso como chegou", async () => {
      const eventoId = await novoEvento("aviso");
      const historico = await eventHistory(db, ator, eventoId);
      assert.equal(historico.externalOrderId, "ord-aviso");
      assert.deepEqual(historico.payload, snapshot("ord-aviso"));
      assert.equal(Array.isArray(historico.auditLogs), true);
      assert.equal(historico.marketplace.name, "ML");
    });

    await t.test("o administrador de outra organização não abre o evento", async () => {
      const outraOrg = await db.organization.create({ data: { name: "Histórico B" } });
      const outroAdmin = await db.user.create({ data: {
        organizationId: outraOrg.id, email: `hist-b-${Date.now()}@local.test`,
        name: "Admin", passwordHash: "x", role: "ADMIN",
      } });
      const eventoId = await novoEvento("alheio");
      await assert.rejects(
        eventHistory(db, { userId: outroAdmin.id, organizationId: outraOrg.id }, eventoId),
        (e: Error) => e instanceof OrderError && /não encontrado/.test(e.message),
        "a resposta é a mesma de evento inexistente: confirmar já diria algo");
    });
  } finally {
    await db.$disconnect();
  }
});
