import { objectInput, OrderError, textInput } from "../../domain/order-input";

export interface SeboNotification {
  topic: string;
  orderId: string;
  /// Identifica a loja; casa com externalAccountId da conexão.
  storeId: string;
  /// Identidade estável: o mesmo aviso reenviado traz o mesmo "sent".
  externalEventId: string;
}

// Mesma forma do aviso do Mercado Livre. O recurso nunca é usado como URL:
// extraímos o id e remontamos a chamada sobre a origem configurada.
export function parseSeboNotification(input: unknown): SeboNotification {
  const value = objectInput(input);
  const topic = textInput(value.topic, "Tópico", 40);
  const resource = textInput(value.resource, "Recurso", 200);
  const match = /^\/orders\/(\d{1,30})$/.exec(resource);
  if (!match) throw new OrderError("Recurso não é um pedido.");
  const sent = textInput(value.sent, "Data de envio", 40);
  const storeId = textInput(value.store_id, "Loja", 100);
  return {
    topic,
    orderId: match[1],
    storeId,
    externalEventId: `sebo:${topic}:${match[1]}:${sent}`.slice(0, 300),
  };
}
