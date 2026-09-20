import "server-only";
import { OrderError } from "../../domain/order-input";

// Host fixo: notificações nunca ditam para onde a aplicação faz a chamada.
export const API_ORIGIN = "https://api.mercadolibre.com";

/// Credencial recusada: exige reautorizar a conexão, não adianta repetir.
export class ProviderAuthError extends Error {}
/// Indisponibilidade ou limite de taxa: vale repetir depois.
export class ProviderTransientError extends Error {}

export async function fetchOrder(accessToken: string, orderId: string, fetcher: typeof fetch = fetch) {
  if (!/^\d{1,30}$/.test(orderId)) throw new OrderError("Pedido externo inválido.");
  const response = await fetcher(`${API_ORIGIN}/orders/${orderId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  // Nenhuma mensagem de erro carrega token ou corpo da resposta.
  if (response.status === 401 || response.status === 403) throw new ProviderAuthError("ML_UNAUTHORIZED");
  if (response.status === 404) throw new OrderError("Pedido não encontrado no Mercado Livre.");
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("ML_UNAVAILABLE");
  if (!response.ok) throw new OrderError("Falha ao consultar o pedido no Mercado Livre.");
  return response.json() as Promise<unknown>;
}
