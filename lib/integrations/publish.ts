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
    // A conta é a que o anúncio registrou quando a publicação foi pedida, e é
    // relida agora porque entre o pedido e a rodada ela pode ter expirado.
    //
    // Sem o `connectionId`, isto era um findFirst por canal, sem critério: num
    // canal com duas contas conectadas -- uma real e uma de teste -- o anúncio
    // ia para a que o banco devolvesse primeiro, sem aviso nenhum.
    const connection = listing.connectionId
      ? await db.marketplaceConnection.findUnique({ where: { id: listing.connectionId } })
      // Anúncio antigo, de antes da coluna existir: só resolve sozinho quando
      // não há ambiguidade.
      : await contaUnicaDoCanal(db, listing.marketplaceId);
    if (!connection) throw new OrderError("O canal não está conectado. Autorize a conexão.");
    if (connection.marketplaceId !== listing.marketplaceId) {
      // A conexão foi movida de canal desde que o anúncio a registrou.
      throw new OrderError("A conta deste anúncio mudou de canal. Peça a publicação de novo.");
    }
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

/// A conta do canal, quando há exatamente uma ativa. Com mais de uma, devolve
/// nulo: escolher por conta própria é o defeito que o `connectionId` corrige.
async function contaUnicaDoCanal(db: PrismaClient, marketplaceId: string) {
  const conexoes = await db.marketplaceConnection.findMany({
    where: { marketplaceId, status: "ACTIVE" }, take: 2,
  });
  return conexoes.length === 1 ? conexoes[0] : null;
}
