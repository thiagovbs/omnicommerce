import "server-only";
import { Receiver } from "@upstash/qstash";
import { EventPublisher } from "../services/outbox";

export class MessagingConfigurationError extends Error {}

export function messagingConfig() {
  const { APP_URL, QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY } = process.env;
  if (!APP_URL || !QSTASH_TOKEN || !QSTASH_CURRENT_SIGNING_KEY || !QSTASH_NEXT_SIGNING_KEY) {
    throw new MessagingConfigurationError("Mensageria não configurada.");
  }
  let app: URL;
  let api: URL;
  try {
    app = new URL(APP_URL);
    api = new URL(process.env.QSTASH_URL ?? "https://qstash.upstash.io");
  } catch { throw new MessagingConfigurationError("Configuração de mensageria inválida."); }
  if (app.protocol !== "https:" || app.username || app.password || app.search || app.hash || app.pathname !== "/" ||
      api.protocol !== "https:" || !/^qstash(?:-[a-z0-9-]+)?\.upstash\.io$/.test(api.hostname) ||
      api.username || api.password || api.port || api.search || api.hash || api.pathname !== "/") {
    throw new MessagingConfigurationError("Configuração de mensageria inválida.");
  }
  return {
    destination: new URL("/api/jobs/marketplace-events", app).toString(), api: api.origin,
    token: QSTASH_TOKEN, currentKey: QSTASH_CURRENT_SIGNING_KEY, nextKey: QSTASH_NEXT_SIGNING_KEY,
  };
}

export function qstashPublisher(fetcher: typeof fetch = fetch): EventPublisher {
  const config = messagingConfig();
  return async ({ eventId, deduplicationId }) => {
    const response = await fetcher(`${config.api}/v2/publish/${config.destination}`, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${config.token}`, "Content-Type": "application/json",
        "Upstash-Deduplication-Id": deduplicationId, "Upstash-Retries": "3", "Upstash-Timeout": "30s",
      }, body: JSON.stringify({ eventId }),
    });
    if (!response.ok) throw new Error("QSTASH_PUBLISH_FAILED");
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
