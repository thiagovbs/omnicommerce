import "server-only";
import { MarketplaceConnection, PrismaClient } from "@prisma/client";
import { OrderError } from "../domain/order-input";
import { OrderSnapshotResolver } from "../services/integration-events";
import { marketplaceSettings } from "../services/marketplaces";
import { decryptSecret, encryptSecret } from "./crypto";
import { fetchOrder, ProviderAuthError } from "./mercadolivre/client";
import { normalizeMercadoLivreOrder } from "./mercadolivre/normalize";
import { refreshToken } from "./mercadolivre/oauth";
import { fetchSeboOrder } from "./sebo/client";
import { normalizeSeboOrder } from "./sebo/normalize";
import { fetchShopeeOrder } from "./shopee/client";
import { normalizeShopeeOrder } from "./shopee/normalize";
import { refreshShopeeToken } from "./shopee/oauth";

// Renova com folga: um token que expira no meio da requisição falharia depois
// de já ter consumido uma tentativa de processamento do evento.
const FOLGA_MS = 60_000;

async function renovarMercadoLivre(
  db: PrismaClient, connection: MarketplaceConnection, fetcher: typeof fetch,
) {
  if (!connection.refreshToken) {
    throw new OrderError("Conexão sem credencial de renovação. Reautorize a conexão.");
  }
  // Credenciais da aplicação: do canal. A leitura é aqui, e não no
  // resolvedor, porque só a renovação precisa delas -- consultar um pedido
  // com token válido não tem por que ir ao banco buscar configuração.
  const cfg = await marketplaceSettings(db, connection.marketplaceId);
  let tokens;
  try {
    tokens = await refreshToken(decryptSecret(connection.refreshToken), cfg, fetcher);
  } catch (error) {
    // Renovação recusada não se resolve repetindo: marca a conexão para
    // reautorização em vez de queimar as tentativas do evento.
    if (error instanceof ProviderAuthError) {
      await db.marketplaceConnection.updateMany({
        where: { id: connection.id }, data: { status: "EXPIRED" },
      });
      throw new OrderError("Autorização do Mercado Livre expirou. Reautorize a conexão.");
    }
    throw error;
  }

  // Compare-and-swap pelo updatedAt: se outra execução renovou primeiro, a
  // gravação não aplica e passamos a usar o token dela. Sem isso, duas
  // execuções simultâneas gravariam tokens diferentes e uma invalidaria a outra.
  const gravou = await db.marketplaceConnection.updateMany({
    where: { id: connection.id, updatedAt: connection.updatedAt },
    data: {
      accessToken: encryptSecret(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : connection.refreshToken,
      expiresAt: tokens.expiresAt,
      status: "ACTIVE",
    },
  });
  if (gravou.count) return tokens.accessToken;

  const atual = await db.marketplaceConnection.findUniqueOrThrow({
    where: { id: connection.id }, select: { accessToken: true },
  });
  if (!atual.accessToken) throw new OrderError("Conexão sem credencial armazenada.");
  return decryptSecret(atual.accessToken);
}

/**
 * Renova a credencial da Shopee.
 *
 * Mesmo compare-and-swap do Mercado Livre, por dois motivos próprios daqui: o
 * access token vale 4 horas, então renovar é rotina e não exceção; e a Shopee
 * INVALIDA o refresh token a cada uso, devolvendo outro. Perder a gravação do
 * novo transforma uma autorização de 365 dias numa de 30 -- e o sintoma
 * apareceria semanas depois, sem ligação com a causa.
 */
async function renovarShopee(
  db: PrismaClient, connection: MarketplaceConnection,
  cfg: Record<string, string>, fetcher: typeof fetch,
) {
  // A Shopee recebe a config de fora: quem chama já a carregou para
  // assinar a consulta do pedido, e buscá-la duas vezes seria desperdício.
  if (!connection.refreshToken) {
    throw new OrderError("Conexão sem credencial de renovação. Reautorize a conexão.");
  }
  let tokens;
  try {
    tokens = await refreshShopeeToken(
      cfg, decryptSecret(connection.refreshToken), connection.externalAccountId, fetcher);
  } catch (error) {
    if (error instanceof ProviderAuthError) {
      await db.marketplaceConnection.updateMany({
        where: { id: connection.id }, data: { status: "EXPIRED" },
      });
      throw new OrderError("Autorização da Shopee expirou. Reautorize a conexão.");
    }
    throw error;
  }

  const gravou = await db.marketplaceConnection.updateMany({
    where: { id: connection.id, updatedAt: connection.updatedAt },
    data: {
      accessToken: encryptSecret(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : connection.refreshToken,
      expiresAt: tokens.expiresAt,
      status: "ACTIVE",
    },
  });
  if (gravou.count) return tokens.accessToken;

  // Outra execução renovou primeiro: vale o token dela. Insistir no nosso
  // invalidaria o que ela acabou de gravar.
  const atual = await db.marketplaceConnection.findUniqueOrThrow({
    where: { id: connection.id }, select: { accessToken: true },
  });
  if (!atual.accessToken) throw new OrderError("Conexão sem credencial armazenada.");
  return decryptSecret(atual.accessToken);
}

// Consulta o pedido no provedor e devolve o snapshot; quem chama valida com
// parseIntegratedOrder, fora de qualquer transação.
export function providerResolver(db: PrismaClient, fetcher: typeof fetch = fetch): OrderSnapshotResolver {
  return async (event) => {
    const { connection } = event;
    if (!connection) throw new OrderError("Evento sem conexão autorizada.");
    if (connection.status !== "ACTIVE") throw new OrderError("Conexão inativa. Reautorize para retomar.");
    if (!connection.accessToken) throw new OrderError("Conexão sem credencial armazenada.");
    const expirando = connection.expiresAt !== null
      && connection.expiresAt.getTime() <= Date.now() + FOLGA_MS;

    switch (connection.provider) {
      case "MERCADO_LIVRE": {
        const token = expirando
          ? await renovarMercadoLivre(db, connection, fetcher)
          : decryptSecret(connection.accessToken);
        return normalizeMercadoLivreOrder(await fetchOrder(token, event.externalOrderId, fetcher));
      }
      case "SEBO_ONLINE": {
        // Token de serviço de vida longa: não há renovação a fazer.
        if (expirando) throw new OrderError("Credencial expirada. Reautorize a conexão.");
        // A URL da loja é do canal: cada organização tem o seu Sebo.
        const cfg = await marketplaceSettings(db, connection.marketplaceId);
        return normalizeSeboOrder(
          await fetchSeboOrder(cfg, decryptSecret(connection.accessToken), event.externalOrderId, fetcher),
        );
      }
      case "SHOPEE": {
        const cfg = await marketplaceSettings(db, connection.marketplaceId);
        const token = expirando
          ? await renovarShopee(db, connection, cfg, fetcher)
          : decryptSecret(connection.accessToken);
        return normalizeShopeeOrder(await fetchShopeeOrder(
          cfg, { accessToken: token, shopId: connection.externalAccountId },
          event.externalOrderId, fetcher));
      }
      case "FACEBOOK":
        // O catálogo do Meta não é canal de venda para nós: o checkout do
        // Facebook é dos Estados Unidos, e a venda do Marketplace acontece
        // na conversa entre as pessoas. Evento de pedido aqui é sinal de
        // configuração errada, não de integração faltando.
        throw new OrderError("O Facebook não tem pedidos aqui: é canal só de publicação.");
      case "OLX":
        // A OLX não tem pedido: ela publica classificado, e o contato do
        // comprador acontece fora. Um evento de pedido neste canal é sinal de
        // configuração errada, não de integração faltando.
        throw new OrderError("A OLX não tem pedidos: é canal só de publicação.");
    }
  };
}
