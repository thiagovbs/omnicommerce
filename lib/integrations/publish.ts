import "server-only";
import { PrismaClient } from "@prisma/client";
import { OrderError } from "../domain/order-input";
import { ListingPublisher } from "../services/listings";
import { decryptSecret } from "./crypto";
import { publishMercadoLivreListing } from "./mercadolivre/catalog";
import { publishSeboProduct } from "./sebo/catalog";

/**
 * Despacho da publicação por provedor.
 *
 * Espelho do `providerResolver`, na direção da saída: aqui só mora a escolha do
 * adapter e o cuidado com a credencial. O que fazer com o resultado é do
 * serviço de anúncios.
 */
export function providerPublisher(db: PrismaClient, fetcher: typeof fetch = fetch): ListingPublisher {
  return async (listing) => {
    // A conexão é buscada agora, e não no pedido de publicação: entre apertar o
    // botão e o trabalhador rodar, a conexão pode ter expirado ou sumido.
    const connection = await db.marketplaceConnection.findFirst({
      where: { marketplaceId: listing.marketplaceId, status: "ACTIVE" },
    });
    if (!connection) throw new OrderError("O canal não está conectado. Autorize a conexão.");
    if (!connection.accessToken) throw new OrderError("Conexão sem credencial armazenada.");
    if (connection.expiresAt !== null && connection.expiresAt.getTime() <= Date.now()) {
      throw new OrderError("Credencial expirada. Reautorize a conexão.");
    }

    switch (connection.provider) {
      case "SEBO_ONLINE":
        return publishSeboProduct(decryptSecret(connection.accessToken), listing.product, fetcher);
      case "MERCADO_LIVRE":
        return publishMercadoLivreListing(decryptSecret(connection.accessToken), listing, fetcher);
      case "SHOPEE":
        throw new OrderError("Publicação na Shopee ainda não implementada.");
    }
  };
}
