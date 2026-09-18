import { objectInput, OrderError, textInput } from "../../domain/order-input";

export interface MercadoLivreNotification {
  topic: string;
  orderId: string;
  externalAccountId: string;
  applicationId: string | null;
  /// Identidade estável do evento: o mesmo aviso reenviado traz o mesmo "sent".
  externalEventId: string;
}

function identifier(value: unknown, label: string) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new OrderError(`${label} inválido.`);
    return String(value);
  }
  return textInput(value, label, 40);
}

// O recurso nunca é usado como URL: extraímos o id e remontamos a chamada num host fixo.
export function parseNotification(input: unknown): MercadoLivreNotification {
  const value = objectInput(input);
  const topic = textInput(value.topic, "Tópico", 40);
  const resource = textInput(value.resource, "Recurso", 200);
  const match = /^\/orders\/(\d{1,30})$/.exec(resource);
  if (!match) throw new OrderError("Recurso não é um pedido.");
  const sent = textInput(value.sent, "Data de envio", 40);
  const externalAccountId = identifier(value.user_id, "Vendedor");
  return {
    topic,
    orderId: match[1],
    externalAccountId,
    applicationId: value.application_id === undefined || value.application_id === null
      ? null : identifier(value.application_id, "Aplicação"),
    externalEventId: `ml:${topic}:${match[1]}:${sent}`.slice(0, 300),
  };
}
