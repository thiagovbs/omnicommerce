export const saleStatuses = [
  "CREATED", "PAID", "INVOICED", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED",
] as const;

export type OrderStatus = (typeof saleStatuses)[number];

const transitions: Record<OrderStatus, readonly OrderStatus[]> = {
  CREATED: ["PAID", "INVOICED", "SHIPPED", "DELIVERED", "CANCELLED"],
  PAID: ["INVOICED", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED"],
  INVOICED: ["SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED"],
  SHIPPED: ["DELIVERED", "CANCELLED", "REFUNDED"],
  DELIVERED: ["REFUNDED"],
  CANCELLED: ["REFUNDED"],
  REFUNDED: [],
};

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && saleStatuses.some((status) => status === value);
}

export function allowedStatusChanges(status: OrderStatus) {
  return transitions[status];
}

export function canChangeStatus(from: OrderStatus, to: OrderStatus) {
  return from === to || transitions[from].includes(to);
}
