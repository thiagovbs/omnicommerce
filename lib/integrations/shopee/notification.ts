import { objectInput, OrderError, textInput } from "../../domain/order-input";

/**
 * Aviso (push) da Shopee.
 *
 * A forma é diferente da do Mercado Livre e do Sebo: não há tópico em texto
 * nem recurso em caminho. Vem um `code` numérico dizendo o assunto, o `shop_id`
 * da loja e um `data` com o conteúdo. Nada disto foi medido contra a
 * plataforma; vem da documentação.
 */

/// Mudança de status de pedido. Os outros códigos existem -- autorização,
/// cancelamento de autorização, rastreio, promoção -- e são ignorados, porque
/// esta rota só alimenta a jornada de pedido.
export const CODIGO_PEDIDO = 3;
/// Loja que retirou a autorização. Não processamos aqui, mas o código é
/// nomeado para a tela poder explicar o silêncio depois.
export const CODIGO_DESAUTORIZACAO = 2;

export interface ShopeeNotification {
  code: number;
  orderSn: string;
  /// Casa com o `externalAccountId` da conexão, e é por ele que o aviso
  /// encontra o tenant.
  shopId: string;
  externalEventId: string;
}

export function parseShopeeNotification(input: unknown): ShopeeNotification | null {
  const value = objectInput(input);
  const code = typeof value.code === "number" ? value.code : null;
  if (code === null) throw new OrderError("Aviso da Shopee sem código.");
  // Assunto que não é pedido é descartado com 200 pelo chamador: devolver erro
  // faria a Shopee reenviar para sempre algo que não nos serve.
  if (code !== CODIGO_PEDIDO) return null;

  const shopId = value.shop_id;
  const loja = typeof shopId === "number" ? String(shopId) : textInput(shopId, "Loja", 30);
  if (!/^\d{1,20}$/.test(loja)) throw new OrderError("Loja inválida no aviso da Shopee.");

  const dados = objectInput(value.data ?? {});
  // `ordersn` é texto no provedor, e é assim que ele viaja em todo o sistema:
  // convertê-lo para número perderia zeros à esquerda.
  const orderSn = textInput(dados.ordersn, "Pedido", 80);
  const timestamp = typeof value.timestamp === "number" ? value.timestamp : null;
  if (timestamp === null) throw new OrderError("Aviso da Shopee sem carimbo de tempo.");
  const status = typeof dados.status === "string" ? dados.status : "";

  return {
    code,
    orderSn,
    shopId: loja,
    // Identidade estável: o mesmo aviso reenviado traz code, pedido, status e
    // carimbo iguais. O status entra porque duas transições podem cair no mesmo
    // segundo, e aí só o carimbo as confundiria.
    externalEventId: `shopee:${code}:${orderSn}:${status}:${timestamp}`.slice(0, 300),
  };
}
