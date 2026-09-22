import { MarketplaceProvider } from "@prisma/client";

/**
 * Provedor de integração de um canal, derivado do código do canal.
 *
 * O código é livre por organização, então nem todo canal tem provedor: um canal
 * sem provedor conhecido não se conecta por OAuth. Sem esta regra a tela oferece
 * a autorização de um provedor em qualquer linha, e como a conexão é única por
 * (provider, externalAccountId), autorizar a partir da linha errada MOVE a
 * conexão existente para aquele canal — e os pedidos do provedor passam a entrar
 * nele, sem erro visível.
 */
const providerPorCodigo: Record<string, MarketplaceProvider> = {
  mercado_livre: "MERCADO_LIVRE",
  mercadolivre: "MERCADO_LIVRE",
  shopee: "SHOPEE",
  olx: "OLX",
  facebook: "FACEBOOK",
  facebook_marketplace: "FACEBOOK",
  sebo: "SEBO_ONLINE",
  sebo_online: "SEBO_ONLINE",
};

export function providerDoCanal(code: string): MarketplaceProvider | null {
  return providerPorCodigo[code.trim().toLowerCase()] ?? null;
}
