import "server-only";
import { MarketplaceConnection, PrismaClient } from "@prisma/client";
import { OrderError, textInput } from "../domain/order-input";
import { assertOrgAdmin } from "./access";
import { UserActor } from "./actor";
import { recordOrderEvent } from "./integration-events";
import { dispatchOutbox, EventPublisher } from "./outbox";

/**
 * Conciliação periódica.
 *
 * O webhook é a via rápida, mas não é garantida: um aviso pode se perder na
 * rede, e no Sebo há uma janela entre gravar o pedido e gravar o aviso. Aqui
 * perguntamos ao provedor o que mudou e enfileiramos o que falta, usando o
 * mesmo caminho dos avisos — nada a jusante muda.
 *
 * Não substitui o webhook: roda espaçado, e serve para fechar lacunas.
 */

/// Quanto olhar para trás quando não há sincronização anterior.
export const JANELA_PADRAO_MS = 24 * 60 * 60 * 1000;
/// Sobreposição sobre a última sincronização, para não perder o que mudou
/// enquanto a rodada anterior estava em andamento.
const SOBREPOSICAO_MS = 60 * 60 * 1000;

export interface PedidoAlterado {
  externalOrderId: string;
  /// Quando mudou no provedor. É o que decide se o nosso registro está velho.
  updatedAt: Date;
}

export type ListarAlterados = (
  connection: MarketplaceConnection, desde: Date,
) => Promise<PedidoAlterado[]>;

export function janelaDe(connection: MarketplaceConnection, agora = new Date()) {
  // A marca é a da própria conciliação, e não `lastSyncedAt`: aquele avança a
  // cada aviso entregue, então um pedido recente empurraria o começo da janela
  // para frente e o pedido mais antigo cujo aviso se perdeu — justamente o que
  // esta rotina existe para repescar — nunca mais seria olhado.
  const base = connection.lastReconciledAt
    ? connection.lastReconciledAt.getTime() - SOBREPOSICAO_MS
    : agora.getTime() - JANELA_PADRAO_MS;
  return new Date(Math.min(base, agora.getTime()));
}

export async function reconcileConnection(
  db: PrismaClient, connection: MarketplaceConnection, listar: ListarAlterados,
) {
  // Carimbado antes de perguntar ao provedor: o que mudar enquanto a rodada
  // corre cai na sobreposição da próxima, em vez de escapar entre as duas.
  const inicio = new Date();
  const desde = janelaDe(connection, inicio);
  const alterados = await listar(connection, desde);

  let enfileirados = 0;
  let emDia = 0;
  for (const pedido of alterados) {
    const atual = await db.sale.findUnique({
      where: {
        marketplaceId_externalOrderId: {
          marketplaceId: connection.marketplaceId,
          externalOrderId: pedido.externalOrderId,
        },
      },
      select: { externalUpdatedAt: true },
    });
    // Já temos esta versão ou mais nova: enfileirar só gastaria cota da fila.
    if (atual?.externalUpdatedAt && atual.externalUpdatedAt >= pedido.updatedAt) {
      emDia++;
      continue;
    }
    // A identidade inclui o carimbo do provedor, então reconciliar o mesmo
    // pedido inalterado não cria evento novo.
    await recordOrderEvent(db, {
      marketplaceId: connection.marketplaceId,
      connectionId: connection.id,
      externalEventId: `recon:${connection.provider}:${pedido.externalOrderId}:${pedido.updatedAt.toISOString()}`,
      externalOrderId: pedido.externalOrderId,
      payload: {
        origem: "conciliacao",
        provider: connection.provider,
        externalOrderId: pedido.externalOrderId,
        updatedAt: pedido.updatedAt.toISOString(),
      },
    });
    enfileirados++;
  }
  // Só depois de tudo enfileirado. Uma falha no meio deixa a marca onde estava,
  // e a rodada seguinte cobre a mesma janela.
  await db.marketplaceConnection.update({
    where: { id: connection.id }, data: { lastReconciledAt: inicio },
  });
  return { verificados: alterados.length, enfileirados, emDia };
}

export async function reconcileAll(db: PrismaClient, listar: ListarAlterados, limite = 20) {
  const connections = await db.marketplaceConnection.findMany({
    where: { status: "ACTIVE", marketplace: { active: true } },
    // Quem está há mais tempo sem conciliar passa na frente do limite.
    orderBy: { lastReconciledAt: { sort: "asc", nulls: "first" } },
    take: limite,
  });

  let verificados = 0;
  let enfileirados = 0;
  const falhas: string[] = [];
  for (const connection of connections) {
    try {
      const resultado = await reconcileConnection(db, connection, listar);
      verificados += resultado.verificados;
      enfileirados += resultado.enfileirados;
    } catch (error) {
      // Uma conexão com problema não pode impedir as outras de conciliar.
      // Só o motivo de domínio entra no relatório; o resto fica genérico,
      // porque pode carregar detalhe do provedor.
      falhas.push(`${connection.provider}/${connection.externalAccountId}: ${
        error instanceof OrderError ? error.message : "falha ao conciliar"
      }`);
    }
  }
  return { conexoes: connections.length, verificados, enfileirados, falhas };
}

/// Quantas rodadas de publicação uma sincronização manual faz. Vinte por
/// rodada: cem avisos cobrem qualquer represamento que alguém vá olhar na
/// tela, e a rota tem 60 segundos para responder.
const RODADAS_DA_SINCRONIZACAO = 5;

export interface ResultadoDaSincronizacao {
  conexoes: number;
  verificados: number;
  enfileirados: number;
  publicados: number;
  falhas: string[];
}

/**
 * Conciliação sob demanda: o botão "Sincronizar agora".
 *
 * Existe porque a conciliação automática roda de hora em hora, e o que ela
 * enfileira ainda espera a rodada seguinte do despachante. Quando alguém
 * percebe que uma venda não entrou, esperar duas engrenagens lentas é a pior
 * resposta possível -- ainda mais numa demonstração.
 *
 * Faz as duas metades no mesmo clique: pergunta ao provedor o que mudou (é a
 * via que NÃO depende de aviso nenhum ter chegado) e esvazia a fila daquela
 * organização em seguida.
 *
 * Duas coisas que ele não faz, de propósito:
 *
 * - **Não busca o pedido nem grava venda aqui.** Isso continua sendo do
 *   trabalhador, que roda fora da requisição. O botão devolve quantos avisos
 *   saíram; as vendas aparecem alguns segundos depois. Processar na
 *   requisição daria um número bonito na tela e um tempo de resposta refém da
 *   API do provedor.
 * - **Não alcança outra organização.** Nem a conciliação nem a publicação: o
 *   filtro é o da organização de quem apertou.
 */
export async function sincronizarAgora(
  db: PrismaClient, actor: UserActor, listar: ListarAlterados, publish: EventPublisher,
  opcoes: { connectionId?: string } = {},
): Promise<ResultadoDaSincronizacao> {
  await assertOrgAdmin(db, actor);
  const connectionId = opcoes.connectionId
    ? textInput(opcoes.connectionId, "Conexão") : undefined;

  const connections = await db.marketplaceConnection.findMany({
    where: {
      status: "ACTIVE",
      // A organização entra na consulta, e não numa conferência depois: id de
      // conexão alheia simplesmente não encontra nada.
      marketplace: { active: true, organizationId: actor.organizationId },
      ...(connectionId ? { id: connectionId } : {}),
    },
    orderBy: { lastReconciledAt: { sort: "asc", nulls: "first" } },
    take: 20,
  });
  if (!connections.length) {
    throw new OrderError(connectionId
      ? "Conexão não encontrada ou inativa."
      : "Nenhuma conta conectada para sincronizar.");
  }

  let verificados = 0;
  let enfileirados = 0;
  const falhas: string[] = [];
  for (const connection of connections) {
    try {
      const resultado = await reconcileConnection(db, connection, listar);
      verificados += resultado.verificados;
      enfileirados += resultado.enfileirados;
    } catch (error) {
      // Uma conexão com problema não impede as outras -- nem impede a fila de
      // esvaziar, que é metade do que o botão promete.
      falhas.push(`${connection.provider}/${connection.externalAccountId}: ${
        error instanceof OrderError ? error.message : "falha ao conciliar"
      }`);
    }
  }

  // Esvazia até acabar ou até o teto. O que sobrar fica para o agendador: a
  // fila não se perde, só demora mais.
  let publicados = 0;
  for (let rodada = 0; rodada < RODADAS_DA_SINCRONIZACAO; rodada += 1) {
    const { published } = await dispatchOutbox(db, publish, 20, actor.organizationId);
    publicados += published;
    if (!published) break;
  }

  await db.auditLog.create({ data: {
    action: "SYNC", entity: "MARKETPLACE_CONNECTION", entityId: connectionId ?? "todas",
    organizationId: actor.organizationId, userId: actor.userId,
    details: `Sincronização manual: ${connections.length} conta(s), ${verificados} pedido(s)`
      + ` verificado(s), ${enfileirados} aviso(s) enfileirado(s), ${publicados} publicado(s).`
      + (falhas.length ? ` Falhas: ${falhas.join("; ")}` : ""),
  } });

  return { conexoes: connections.length, verificados, enfileirados, publicados, falhas };
}
