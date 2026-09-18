import { Prisma } from "@prisma/client";
import { objectInput, OrderError, textInput } from "../../domain/order-input";
import { OrderStatus } from "../../domain/sale-status";

/**
 * Mapeamento do pedido do Mercado Livre para o snapshot interno.
 *
 * VALIDAR CONTRA PAYLOAD REAL antes de operar: o portal de desenvolvedores do ML
 * responde 403 a consulta automatizada, então os caminhos abaixo são a intenção
 * declarada do mapeamento, não contrato confirmado. Conferir com um pedido real da
 * conta autorizada e corrigir AQUI — este é o único arquivo com semântica de valores.
 *
 * - itens       <- order_items[]: item.title, item.seller_sku, item.id, item.variation_id,
 *                  quantity, unit_price
 * - bruto       <- soma de unit_price * quantity (os itens definem o bruto)
 * - desconto    <- bruto - total_amount (cupom/desconto do pedido)
 * - frete       <- shipping_cost do pedido, ou soma de payments[].shipping_cost
 * - taxas       <- soma de order_items[].sale_fee
 * - líquido     <- calculado por parseOrder: bruto + frete - desconto - taxas
 * - status      <- order.status (ver statusMap)
 * - atualizado  <- last_updated; vendido em <- date_created
 *
 * Campo monetário ausente é erro nomeado, nunca zero presumido. Valores são
 * arredondados a duas casas porque é a precisão de armazenamento (Decimal(14,2)).
 *
 * LIMITE CONHECIDO: o recurso de pedido não carrega estado de envio, então este
 * mapeamento nunca produz SHIPPED nem DELIVERED — isso depende de integrar o
 * recurso de shipments. Reembolso também não é inferido de payments[].
 */
const statusMap: Record<string, OrderStatus> = {
  confirmed: "CREATED",
  payment_required: "CREATED",
  payment_in_process: "CREATED",
  partially_paid: "CREATED",
  paid: "PAID",
  cancelled: "CANCELLED",
  invalid: "CANCELLED",
};

function amount(value: unknown, label: string) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Prisma.Decimal(value).toDecimalPlaces(2);
  }
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
    return new Prisma.Decimal(value).toDecimalPlaces(2);
  }
  throw new OrderError(`${label} ausente ou inválido no pedido do Mercado Livre.`);
}

function optionalIdentifier(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  return String(value).slice(0, 200);
}

function shippingCost(order: Record<string, unknown>) {
  if (order.shipping_cost !== undefined && order.shipping_cost !== null) {
    return amount(order.shipping_cost, "Frete");
  }
  const payments = Array.isArray(order.payments) ? order.payments : null;
  if (payments?.length) {
    return payments
      .reduce(
        (sum: Prisma.Decimal, raw) => sum.add(amount(objectInput(raw).shipping_cost, "Frete do pagamento")),
        new Prisma.Decimal(0),
      )
      .toDecimalPlaces(2);
  }
  throw new OrderError("Frete não informado no pedido do Mercado Livre.");
}

function buyerName(order: Record<string, unknown>) {
  if (!order.buyer) return null;
  const buyer = objectInput(order.buyer);
  const full = [buyer.first_name, buyer.last_name].filter((part) => typeof part === "string" && part.trim()).join(" ");
  const name = full.trim() || (typeof buyer.nickname === "string" ? buyer.nickname.trim() : "");
  return name ? name.slice(0, 200) : null;
}

function buyerEmail(order: Record<string, unknown>) {
  if (!order.buyer) return null;
  const email = objectInput(order.buyer).email;
  return typeof email === "string" && email.includes("@") ? email.slice(0, 254) : null;
}

export function normalizeMercadoLivreOrder(input: unknown) {
  const order = objectInput(input);

  const rawItems = Array.isArray(order.order_items) ? order.order_items : [];
  if (!rawItems.length) throw new OrderError("Pedido do Mercado Livre sem itens.");

  let itemsTotal = new Prisma.Decimal(0);
  let fees = new Prisma.Decimal(0);
  const items = rawItems.map((raw) => {
    const line = objectInput(raw);
    const item = objectInput(line.item);
    if (typeof line.quantity !== "number" || !Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw new OrderError("Quantidade inválida no pedido do Mercado Livre.");
    }
    const unitPrice = amount(line.unit_price, "Preço unitário do item");
    fees = fees.add(amount(line.sale_fee, "Taxa de venda do item"));
    itemsTotal = itemsTotal.add(unitPrice.mul(line.quantity));
    return {
      title: textInput(item.title, "Título do item", 500),
      sku: optionalIdentifier(item.seller_sku),
      externalItemId: optionalIdentifier(item.id),
      externalVariationId: optionalIdentifier(item.variation_id),
      quantity: line.quantity,
      unitPrice: unitPrice.toFixed(2),
    };
  });

  // O total do pedido já vem líquido de cupom, então a diferença contra os itens é o desconto.
  const discount = itemsTotal.sub(amount(order.total_amount, "Total do pedido"));
  if (discount.isNegative()) {
    throw new OrderError("Total do pedido excede a soma dos itens; mapeamento de valores precisa de revisão.");
  }

  const externalStatus = textInput(order.status, "Status do pedido", 100);
  const status = statusMap[externalStatus];
  if (!status) throw new OrderError(`Status "${externalStatus}" do Mercado Livre não mapeado.`);
  const detail = typeof order.status_detail === "string" && order.status_detail.trim()
    ? `:${order.status_detail.trim()}` : "";

  return {
    externalOrderId: textInput(optionalIdentifier(order.id), "Identificador do pedido"),
    status,
    externalStatus: `${externalStatus}${detail}`.slice(0, 200),
    externalUpdatedAt: textInput(order.last_updated, "Data de atualização", 40),
    soldAt: textInput(order.date_created, "Data de criação", 40),
    currency: textInput(order.currency_id, "Moeda", 10),
    gross: itemsTotal.toFixed(2),
    shipping: shippingCost(order).toFixed(2),
    discount: discount.toFixed(2),
    fees: fees.toDecimalPlaces(2).toFixed(2),
    customerName: buyerName(order),
    customerEmail: buyerEmail(order),
    items,
  };
}
