import "server-only";
import { OrderError } from "../../domain/order-input";
import { ProviderAuthError, ProviderTransientError } from "../mercadolivre/client";

export class SeboConfigurationError extends Error {}

// O sebo é exposto pelo gateway da Sensedia, que pode servir sob um prefixo de
// caminho — por isso a base preserva o pathname em vez de usar só a origem.
export function seboApiBase() {
  const raw = process.env.SEBO_API_URL;
  if (!raw) throw new SeboConfigurationError("SEBO_API_URL não configurada.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new SeboConfigurationError("SEBO_API_URL inválida."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new SeboConfigurationError("SEBO_API_URL inválida.");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export async function fetchSeboOrder(token: string, orderId: string, fetcher: typeof fetch = fetch) {
  if (!/^\d{1,30}$/.test(orderId)) throw new OrderError("Pedido externo inválido.");
  const response = await fetcher(`${seboApiBase()}/integration/orders/${orderId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  // Nenhuma mensagem de erro carrega token ou corpo da resposta.
  if (response.status === 401 || response.status === 403) throw new ProviderAuthError("SEBO_UNAUTHORIZED");
  if (response.status === 404) throw new OrderError("Pedido não encontrado no Sebo On-Line.");
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("SEBO_UNAVAILABLE");
  if (!response.ok) throw new OrderError("Falha ao consultar o pedido no Sebo On-Line.");
  return response.json() as Promise<unknown>;
}
