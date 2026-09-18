import "server-only";
import { MarketplaceConnection, PrismaClient } from "@prisma/client";
import { OrderError } from "../domain/order-input";
import { OrderSnapshotResolver } from "../services/integration-events";
import { decryptSecret, encryptSecret } from "./crypto";
import { fetchOrder, ProviderAuthError } from "./mercadolivre/client";
import { normalizeMercadoLivreOrder } from "./mercadolivre/normalize";
import { refreshToken } from "./mercadolivre/oauth";
import { fetchSeboOrder } from "./sebo/client";
import { normalizeSeboOrder } from "./sebo/normalize";

// Renova com folga: um token que expira no meio da requisição falharia depois
// de já ter consumido uma tentativa de processamento do evento.
const FOLGA_MS = 60_000;

async function renovarMercadoLivre(
  db: PrismaClient, connection: MarketplaceConnection, fetcher: typeof fetch,
) {
  if (!connection.refreshToken) {
    throw new OrderError("Conexão sem credencial de renovação. Reautorize a conexão.");
  }
  let tokens;
  try {
    tokens = await refreshToken(decryptSecret(connection.refreshToken), fetcher);
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
        return normalizeSeboOrder(
          await fetchSeboOrder(decryptSecret(connection.accessToken), event.externalOrderId, fetcher),
        );
      }
      case "SHOPEE":
        throw new OrderError("Integração de pedidos da Shopee não implementada.");
    }
  };
}
