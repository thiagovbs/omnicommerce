import "server-only";
import { Receiver } from "@upstash/qstash";
import { EventPublisher } from "../services/outbox";

export class MessagingConfigurationError extends Error {}

export function messagingConfig() {
  const { APP_URL, QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY } = process.env;
  // A checagem direta mantém o estreitamento de tipo; o nome da variável que
  // falta entra na mensagem, porque a genérica obrigava a adivinhar qual das quatro.
  if (!APP_URL || !QSTASH_TOKEN || !QSTASH_CURRENT_SIGNING_KEY || !QSTASH_NEXT_SIGNING_KEY) {
    const ausentes = Object.entries({
      APP_URL, QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY,
    }).filter(([, valor]) => !valor).map(([nome]) => nome);
    throw new MessagingConfigurationError(`Mensageria não configurada: ${ausentes.join(", ")}.`);
  }
  let app: URL;
  let api: URL;
  try {
    app = new URL(APP_URL);
    api = new URL(process.env.QSTASH_URL ?? "https://qstash.upstash.io");
  } catch { throw new MessagingConfigurationError("Configuração de mensageria inválida: URL não reconhecida."); }
  if (app.protocol !== "https:" || app.username || app.password || app.search || app.hash || app.pathname !== "/") {
    throw new MessagingConfigurationError("Configuração de mensageria inválida: APP_URL.");
  }
  if (api.protocol !== "https:" || !/^qstash(?:-[a-z0-9-]+)?\.upstash\.io$/.test(api.hostname) ||
      api.username || api.password || api.port || api.search || api.hash || api.pathname !== "/") {
    throw new MessagingConfigurationError("Configuração de mensageria inválida: QSTASH_URL.");
  }
  return {
    destination: new URL("/api/jobs/marketplace-events", app).toString(), api: api.origin,
    token: QSTASH_TOKEN, currentKey: QSTASH_CURRENT_SIGNING_KEY, nextKey: QSTASH_NEXT_SIGNING_KEY,
  };
}

export function qstashPublisher(fetcher: typeof fetch = fetch): EventPublisher {
  const config = messagingConfig();
  return async ({ eventId, deduplicationId }) => {
    // Falha no limite, com nome, em vez de levar 400 do QStash e registrar
    // "publicação falhou" sem dizer por quê.
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(deduplicationId)) {
      throw new Error("QSTASH_INVALID_DEDUPLICATION_ID");
    }
    const response = await fetcher(`${config.api}/v2/publish/${config.destination}`, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${config.token}`, "Content-Type": "application/json",
        "Upstash-Deduplication-Id": deduplicationId, "Upstash-Retries": "3", "Upstash-Timeout": "30s",
      }, body: JSON.stringify({ eventId }),
    });
    // O status entra na mensagem: é o que distingue destino errado (404),
    // credencial recusada (401) e cota estourada (429) na hora do diagnóstico.
    // Nunca o corpo da resposta, que pode ecoar cabeçalho.
    if (!response.ok) throw new Error(`QSTASH_PUBLISH_FAILED_${response.status}`);
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || !("messageId" in result) || typeof result.messageId !== "string") {
      throw new Error("QSTASH_INVALID_RESPONSE");
    }
  };
}

export async function verifyJobSignature(signature: string, body: string) {
  const config = messagingConfig();
  const receiver = new Receiver({ currentSigningKey: config.currentKey, nextSigningKey: config.nextKey, devMode: false });
  try { return await receiver.verify({ signature, body, url: config.destination }); }
  catch { return false; }
}
