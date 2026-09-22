import "server-only";
import { objectInput, OrderError } from "../../domain/order-input";
import {
  ProviderAuthError, ProviderOrderGoneError, ProviderTransientError,
} from "../mercadolivre/client";

export class SeboConfigurationError extends Error { override name = "SeboConfigurationError"; }

// O sebo é exposto pelo gateway da Sensedia, que pode servir sob um prefixo de
// caminho — por isso a base preserva o pathname em vez de usar só a origem.
/**
 * Base da API do Sebo, vinda do cadastro do CANAL.
 *
 * Era `SEBO_API_URL` no ambiente: um endereço para todas as organizações do
 * deploy, quando cada organização tem a SUA loja. Agora vem da tela de
 * Marketplaces, e o que chega aqui é o cadastro daquele canal.
 */
export function seboApiBase(cfg: Record<string, string>) {
  const raw = cfg.apiUrl;
  if (!raw) {
    throw new SeboConfigurationError(
      "URL da API do Sebo não configurada. Preencha na tela de Marketplaces.");
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new SeboConfigurationError("URL da API do Sebo inválida."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new SeboConfigurationError("URL da API do Sebo inválida.");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export async function fetchSeboOrder(
  cfg: Record<string, string>, token: string, orderId: string, fetcher: typeof fetch = fetch,
) {
  if (!/^\d{1,30}$/.test(orderId)) throw new OrderError("Pedido externo inválido.");
  const response = await fetcher(`${seboApiBase(cfg)}/integration/orders/${orderId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  // Nenhuma mensagem de erro carrega token ou corpo da resposta.
  if (response.status === 401 || response.status === 403) throw new ProviderAuthError("SEBO_UNAUTHORIZED");
  // 404 aqui não é "falhou": é a loja dizendo que este pedido não existe
  // mais. Repetir não o traz de volta, e não há cadastro a corrigir.
  if (response.status === 404) {
    throw new ProviderOrderGoneError("Pedido não encontrado no Sebo On-Line.");
  }
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("SEBO_UNAVAILABLE");
  if (!response.ok) throw new OrderError("Falha ao consultar o pedido no Sebo On-Line.");
  return response.json() as Promise<unknown>;
}

/// Lista o que mudou desde uma data, para a conciliação. Só identificação e
/// carimbo: o pedido inteiro é buscado depois, pelo caminho normal.
export async function listChangedSeboOrders(
  cfg: Record<string, string>, token: string, desde: Date, fetcher: typeof fetch = fetch,
) {
  const url = `${seboApiBase(cfg)}/integration/orders?updated_since=${
    encodeURIComponent(desde.toISOString())}&limit=200`;
  const response = await fetcher(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403) throw new ProviderAuthError("SEBO_UNAUTHORIZED");
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("SEBO_UNAVAILABLE");
  if (!response.ok) throw new OrderError("Falha ao listar pedidos no Sebo On-Line.");

  const corpo: unknown = await response.json();
  const itens = Array.isArray(corpo) ? corpo : null;
  if (!itens) throw new OrderError("Listagem do Sebo On-Line em formato inesperado.");
  return itens.map((item) => {
    const linha = objectInput(item);
    const externalOrderId = linha.id === undefined || linha.id === null
      ? "" : String(linha.id);
    const carimbo = typeof linha.updated_at === "string" ? new Date(linha.updated_at) : null;
    if (!externalOrderId || !carimbo || !Number.isFinite(carimbo.getTime())) {
      throw new OrderError("Pedido sem identificador ou data na listagem do Sebo On-Line.");
    }
    return { externalOrderId, updatedAt: carimbo };
  });
}
