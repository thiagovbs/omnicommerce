import "server-only";
import { PrismaClient } from "@prisma/client";
import { OrderError } from "../domain/order-input";
import { ListingPublisher } from "../services/listings";
import { decryptSecret } from "./crypto";
import { publishMercadoLivreListing } from "./mercadolivre/catalog";
import { marketplaceSettings } from "../services/marketplaces";
import { organizationProfile } from "../services/organizations";
import { publishOlxAd } from "./olx/catalog";
import { publishSeboProduct } from "./sebo/catalog";
import { publishShopeeListing } from "./shopee/catalog";

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

    // Configuração do canal: credenciais da aplicação e endereços. Moravam no
    // ambiente, o que dava uma aplicação para todas as organizações do mesmo
    // deploy; agora são do canal, e o canal é de uma organização.
    const cfg = await marketplaceSettings(db, listing.marketplaceId);

    switch (connection.provider) {
      case "SEBO_ONLINE":
        return publishSeboProduct(cfg, decryptSecret(connection.accessToken), listing.product, fetcher);
      case "MERCADO_LIVRE":
        return publishMercadoLivreListing(decryptSecret(connection.accessToken), listing, fetcher);
      case "SHOPEE":
        // A loja faz parte da credencial na Shopee: o `shop_id` entra na
        // assinatura de toda chamada, e é o `externalAccountId` da conexão.
        return publishShopeeListing(
          cfg, { accessToken: decryptSecret(connection.accessToken), shopId: connection.externalAccountId },
          listing, fetcher);
      case "OLX": {
        // Telefone e CEP do anúncio são da ORGANIZAÇÃO do produto, lidos agora:
        // o mesmo deploy atende vários tenants, e um valor de ambiente faria o
        // anúncio de um sair com o telefone do outro.
        const empresa = await organizationProfile(db, listing.product.organizationId);
        return publishOlxAd(
          cfg, decryptSecret(connection.accessToken), listing,
          { telefone: empresa.phone, cep: empresa.zipCode }, fetcher);
      }
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
