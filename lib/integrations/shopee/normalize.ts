import { Prisma } from "@prisma/client";
import { objectInput, OrderError, textInput } from "../../domain/order-input";
import { OrderStatus } from "../../domain/sale-status";

/**
 * Pedido da Shopee para o snapshot interno.
 *
 * Como no Mercado Livre, campo monetário ausente é erro nomeado — nunca zero
 * presumido. Zero só existe declarado, e cada um deles está justificado abaixo.
 *
 * Decisões de valor, todas explícitas:
 * - bruto     <- soma de `model_discounted_price * model_quantity_purchased`.
 *               É o preço que o comprador pagou por item; `original_price`
 *               seria o preço de tabela e inflaria a venda.
 * - frete     <- `actual_shipping_fee`, ou `estimated_shipping_fee` quando o
 *               frete real ainda não fechou. Sem nenhum dos dois é erro: frete
 *               ausente não é frete grátis.
 * - desconto  <- 0,00 DECLARADO. O desconto já está embutido no preço por
 *               item; subtrair de novo contaria duas vezes.
 * - taxas     <- 0,00 DECLARADO. A comissão da Shopee vive no `escrow_detail`,
 *               que é outra chamada e outro momento (ela muda depois do
 *               pedido). Registrar zero aqui é honesto; inventar percentual não.
 *
 * `total_amount` NÃO é usado como bruto de propósito: a documentação não deixa
 * claro se ele inclui frete, e um bruto que às vezes carrega frete e às vezes
 * não produziria relatório errado sem nenhum sintoma.
 *
 * LIMITE CONHECIDO: a Shopee tem estados de logística (`SHIPPED`, `TO_CONFIRM_RECEIVE`)
 * que este mapeamento reduz a SHIPPED/DELIVERED apenas quando o nome é
 * inequívoco. Estado desconhecido é erro, e não um palpite.
 */
const statusMap: Record<string, OrderStatus> = {
  UNPAID: "CREATED",
  READY_TO_SHIP: "PAID",
  PROCESSED: "PAID",
  RETRY_SHIP: "PAID",
  SHIPPED: "SHIPPED",
  TO_CONFIRM_RECEIVE: "SHIPPED",
  COMPLETED: "DELIVERED",
  // Cancelamento em curso já conta como cancelado: o estoque precisa voltar
  // antes de a Shopee fechar o processo, não depois.
  IN_CANCEL: "CANCELLED",
  CANCELLED: "CANCELLED",
  UNDELIVERED: "CANCELLED",
  TO_RETURN: "REFUNDED",
};

function amount(value: unknown, label: string) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Prisma.Decimal(value).toDecimalPlaces(2);
  }
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
    return new Prisma.Decimal(value).toDecimalPlaces(2);
  }
  throw new OrderError(`${label} ausente ou inválido no pedido da Shopee.`);
}

function optionalText(value: unknown, max: number) {
  if (value === undefined || value === null || value === "") return null;
  return String(value).slice(0, max);
}

/// A Shopee carimba em segundos; o resto do sistema fala ISO-8601.
function instante(valor: unknown, label: string) {
  if (typeof valor !== "number" || !Number.isFinite(valor) || valor <= 0) {
    throw new OrderError(`${label} ausente ou inválido no pedido da Shopee.`);
  }
  return new Date(valor * 1000).toISOString();
}

export function normalizeShopeeOrder(input: unknown) {
  const order = objectInput(input);

  const brutos = Array.isArray(order.item_list) ? order.item_list : [];
  if (!brutos.length) throw new OrderError("Pedido da Shopee sem itens.");

  let soma = new Prisma.Decimal(0);
  const items = brutos.map((cru) => {
    const item = objectInput(cru);
    const quantidade = item.model_quantity_purchased;
    if (typeof quantidade !== "number" || !Number.isSafeInteger(quantidade) || quantidade < 1) {
      throw new OrderError("Quantidade inválida no pedido da Shopee.");
    }
    const unitario = amount(item.model_discounted_price, "Preço unitário do item");
    soma = soma.add(unitario.mul(quantidade));
    return {
      title: textInput(item.item_name, "Nome do item", 500),
      // O SKU liga o item ao catálogo e é o que permite baixar estoque. A
      // Shopee tem SKU no item e na variação; a variação é mais específica e
      // vence quando existe.
      sku: (optionalText(item.model_sku, 60) ?? optionalText(item.item_sku, 60))?.toUpperCase() ?? null,
      externalItemId: optionalText(item.item_id, 200),
      externalVariationId: optionalText(item.model_id, 200),
      quantity: quantidade,
      unitPrice: unitario.toFixed(2),
    };
  });

  // Frete real quando existe; estimado enquanto o envio não fechou. A ausência
  // dos dois é erro: pedido sem nenhuma informação de frete não é frete zero.
  const frete = order.actual_shipping_fee !== undefined && order.actual_shipping_fee !== null
    ? amount(order.actual_shipping_fee, "Frete")
    : amount(order.estimated_shipping_fee, "Frete estimado");

  const externalStatus = textInput(order.order_status, "Status do pedido", 100);
  const status = statusMap[externalStatus];
  if (!status) throw new OrderError(`Status "${externalStatus}" da Shopee não mapeado.`);

  const endereco = order.recipient_address ? objectInput(order.recipient_address) : {};

  return {
    externalOrderId: textInput(order.order_sn, "Identificador do pedido", 80),
    status,
    externalStatus,
    // update_time precisa avançar a cada mudança: é o que descarta aviso atrasado.
    externalUpdatedAt: instante(order.update_time, "Data de atualização"),
    soldAt: instante(order.create_time, "Data de criação"),
    currency: textInput(order.currency, "Moeda", 3).toUpperCase(),
    gross: soma.toFixed(2),
    shipping: frete.toFixed(2),
    discount: "0.00",
    fees: "0.00",
    // O nome do destinatário é o dado de cliente mais confiável; o
    // `buyer_username` é apelido de plataforma e serve de reserva.
    customerName: optionalText(endereco.name, 200) ?? optionalText(order.buyer_username, 200),
    // A Shopee mascara o e-mail do comprador por padrão. Ausência é a regra
    // aqui, não exceção.
    customerEmail: optionalText(order.buyer_email, 254),
    items,
  };
}
