import { Currency, Prisma } from "@prisma/client";
import { isOrderStatus } from "./sale-status";

export class OrderError extends Error {}

export function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OrderError("Dados do pedido inválidos.");
  }
  return value as Record<string, unknown>;
}

export function textInput(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new OrderError(`${label} inválido.`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string, max = 200) {
  return value === undefined || value === null || value === "" ? null : textInput(value, label, max);
}

function money(value: unknown, label: string) {
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^\d{1,12}(\.\d{1,2})?$/.test(String(value))) {
    throw new OrderError(`${label} deve ser um valor positivo com até duas casas decimais.`);
  }
  return new Prisma.Decimal(String(value));
}

function checkMoneyRange(value: Prisma.Decimal, label: string) {
  if (value.abs().greaterThan("999999999999.99")) throw new OrderError(`${label} excede o limite.`);
  return value;
}

function dateInput(value: unknown, label: string, timestamp = false) {
  const text = textInput(value, label, 40);
  // Fração de segundo com qualquer precisão: o ISO 8601 permite, e provedores
  // divergem — o Mercado Livre manda milissegundos, o Python manda microssegundos.
  if (timestamp && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new OrderError(`${label} deve incluir horário e fuso.`);
  }
  if (!timestamp && !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(text)) throw new OrderError(`${label} inválida.`);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new OrderError(`${label} inválida.`);
  // Reject normalization of impossible dates such as February 30.
  const day = new Date(`${text.slice(0, 10)}T00:00:00Z`);
  if (day.toISOString().slice(0, 10) !== text.slice(0, 10)) throw new OrderError(`${label} inválida.`);
  return date;
}

export function parseOrder(input: unknown) {
  const value = objectInput(input);
  if (!Array.isArray(value.items) || !value.items.length || value.items.length > 500) {
    throw new OrderError("Informe entre 1 e 500 itens.");
  }
  const items = value.items.map((raw) => {
    const item = objectInput(raw);
    if ((typeof item.quantity !== "number" && typeof item.quantity !== "string") ||
        !/^\d+$/.test(String(item.quantity))) throw new OrderError("Quantidade inválida.");
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2147483647) {
      throw new OrderError("Quantidade inválida.");
    }
    const unitPrice = money(item.unitPrice, "Preço unitário");
    return {
      title: textInput(item.title, "Título do item", 500),
      sku: optionalText(item.sku, "SKU"),
      externalItemId: optionalText(item.externalItemId, "ID externo do item"),
      externalVariationId: optionalText(item.externalVariationId, "ID da variação"),
      quantity, unitPrice,
      total: checkMoneyRange(unitPrice.mul(quantity), "Total do item"),
    };
  });
  const gross = checkMoneyRange(items.reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0)), "Bruto");
  if (value.gross !== undefined && !money(value.gross, "Bruto").equals(gross)) {
    throw new OrderError("O valor bruto deve corresponder à soma dos itens.");
  }
  const shipping = money(value.shipping ?? 0, "Frete");
  const discount = money(value.discount ?? 0, "Desconto");
  const fees = money(value.fees ?? 0, "Taxas");
  const currency = value.currency ?? "BRL";
  if (!Object.values(Currency).includes(currency as Currency)) throw new OrderError("Moeda inválida.");
  return {
    externalOrderId: textInput(value.externalOrderId, "ID do pedido"),
    soldAt: dateInput(value.soldAt, "Data da venda"),
    currency: currency as Currency,
    gross, shipping, discount, fees,
    net: checkMoneyRange(gross.add(shipping).sub(discount).sub(fees), "Líquido"),
    customerName: optionalText(value.customerName, "Nome do cliente"),
    customerEmail: optionalText(value.customerEmail, "E-mail do cliente", 254),
    notes: optionalText(value.notes, "Observações", 4000),
    items,
  };
}

export function parseIntegratedOrder(input: unknown) {
  const value = objectInput(input);
  if (!isOrderStatus(value.status)) throw new OrderError("Status inválido.");
  // A normalized snapshot must explicitly distinguish known zero from missing values.
  for (const key of ["gross", "shipping", "discount", "fees", "currency"]) {
    if (value[key] === undefined || value[key] === null) throw new OrderError(`Campo obrigatório: ${key}.`);
  }
  return {
    ...parseOrder(value),
    status: value.status,
    externalStatus: textInput(value.externalStatus, "Status externo"),
    externalUpdatedAt: dateInput(value.externalUpdatedAt, "Data externa", true),
  };
}

export type IntegratedOrder = ReturnType<typeof parseIntegratedOrder>;
