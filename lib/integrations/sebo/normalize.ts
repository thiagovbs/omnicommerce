import { Prisma } from "@prisma/client";
import { objectInput, OrderError, textInput } from "../../domain/order-input";
import { OrderStatus } from "../../domain/sale-status";

/**
 * Mapeamento do pedido do Sebo On-Line para o snapshot interno.
 *
 * Diferente do Mercado Livre, o contrato aqui é NOSSO: o endpoint
 * `GET /integration/orders/{id}` do sebo ainda precisa ser escrito, e é este
 * arquivo que define o que ele deve devolver. A fixture do teste é a
 * especificação executável — se o sebo divergir dela, o teste quebra.
 *
 * Campos esperados:
 * - id, status, total, created_at, updated_at
 * - items[]: name, unit_price, quantity, product_id
 * - customer: name, email (opcionais)
 *
 * Decisões de valor, todas explícitas:
 * - bruto     <- soma de unit_price * quantity (os itens definem o bruto)
 * - desconto  <- bruto - total, quando o total vier menor (cupom futuro)
 * - frete     <- 0,00. O sebo NÃO tem frete no domínio; é zero declarado, não
 *                presumido por ausência de campo.
 * - taxas     <- 0,00, pela mesma razão: não há taxa de marketplace numa loja própria.
 * - moeda     <- BRL fixo: o sebo opera só em real.
 *
 * O sebo guarda dinheiro em float, então todo valor é quantizado a duas casas
 * antes de virar Decimal — que é a precisão de armazenamento (Decimal(14,2)).
 */
const statusMap: Record<string, OrderStatus> = {
  CREATED: "CREATED",
  AWAITING_PAYMENT: "CREATED",
  PAID: "PAID",
  CANCELLED: "CANCELLED",
  // Pagamento que falhou encerra o pedido; não há estado próprio para isso.
  FAILED: "CANCELLED",
};

function amount(value: unknown, label: string) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Prisma.Decimal(value).toDecimalPlaces(2);
  }
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
    return new Prisma.Decimal(value).toDecimalPlaces(2);
  }
  throw new OrderError(`${label} ausente ou inválido no pedido do Sebo On-Line.`);
}

function optionalText(value: unknown, max: number) {
  if (value === undefined || value === null || value === "") return null;
  return String(value).slice(0, max);
}

export function normalizeSeboOrder(input: unknown) {
  const order = objectInput(input);

  const rawItems = Array.isArray(order.items) ? order.items : [];
  if (!rawItems.length) throw new OrderError("Pedido do Sebo On-Line sem itens.");

  let itemsTotal = new Prisma.Decimal(0);
  const items = rawItems.map((raw) => {
    const item = objectInput(raw);
    if (typeof item.quantity !== "number" || !Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new OrderError("Quantidade inválida no pedido do Sebo On-Line.");
    }
    const unitPrice = amount(item.unit_price, "Preço unitário do item");
    itemsTotal = itemsTotal.add(unitPrice.mul(item.quantity));
    return {
      title: textInput(item.name, "Nome do item", 500),
      sku: null,
      externalItemId: optionalText(item.product_id, 200),
      externalVariationId: null,
      quantity: item.quantity,
      unitPrice: unitPrice.toFixed(2),
    };
  });

  const discount = itemsTotal.sub(amount(order.total, "Total do pedido"));
  if (discount.isNegative()) {
    throw new OrderError("Total do pedido excede a soma dos itens; mapeamento de valores precisa de revisão.");
  }

  const externalStatus = textInput(order.status, "Status do pedido", 100);
  const status = statusMap[externalStatus];
  if (!status) throw new OrderError(`Status "${externalStatus}" do Sebo On-Line não mapeado.`);

  const customer = order.customer ? objectInput(order.customer) : {};

  return {
    externalOrderId: textInput(optionalText(order.id, 200), "Identificador do pedido"),
    status,
    externalStatus,
    // updated_at precisa avançar a cada mudança de status: é o que descarta evento atrasado.
    externalUpdatedAt: textInput(order.updated_at, "Data de atualização", 40),
    soldAt: textInput(order.created_at, "Data de criação", 40),
    currency: "BRL",
    gross: itemsTotal.toFixed(2),
    shipping: "0.00",
    discount: discount.toFixed(2),
    fees: "0.00",
    customerName: optionalText(customer.name, 200),
    customerEmail: optionalText(customer.email, 254),
    items,
  };
}
