import "server-only";
import { OrderError } from "../../domain/order-input";
import { ProviderAuthError, ProviderTransientError } from "./client";

/**
 * Autorização OAuth do Mercado Livre.
 *
 * O host de autorização e o de token NÃO foram confirmados na documentação
 * oficial (o portal responde 403 a consulta automatizada), então os dois são
 * configuráveis: um valor errado se corrige por variável de ambiente, sem
 * deploy de código.
 */
const AUTH_BASE_PADRAO = "https://auth.mercadolivre.com.br/authorization";
const TOKEN_BASE_PADRAO = "https://api.mercadolibre.com/oauth/token";

export class OAuthConfigurationError extends Error {}

function origem(valor: string, nome: string, permitidos: RegExp) {
  let url: URL;
  try { url = new URL(valor); } catch { throw new OAuthConfigurationError(`${nome} inválida.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      !permitidos.test(url.hostname)) {
    throw new OAuthConfigurationError(`${nome} inválida.`);
  }
  return url;
}

export function oauthConfig() {
  const { MERCADO_LIVRE_APP_ID, MERCADO_LIVRE_APP_SECRET, APP_URL } = process.env;
  const ausentes = Object.entries({ MERCADO_LIVRE_APP_ID, MERCADO_LIVRE_APP_SECRET, APP_URL })
    .filter(([, valor]) => !valor).map(([nome]) => nome);
  if (!MERCADO_LIVRE_APP_ID || !MERCADO_LIVRE_APP_SECRET || !APP_URL) {
    throw new OAuthConfigurationError(`OAuth do Mercado Livre não configurado: ${ausentes.join(", ")}.`);
  }
  // Só domínios do Mercado Livre, para configuração errada não virar
  // redirecionamento para host arbitrário.
  const mercadoLivre = /^([a-z0-9-]+\.)*mercado(livre|libre)\.com(\.[a-z]{2})?$/;
  const authBase = origem(process.env.MERCADO_LIVRE_AUTH_URL ?? AUTH_BASE_PADRAO, "MERCADO_LIVRE_AUTH_URL", mercadoLivre);
  const tokenBase = origem(process.env.MERCADO_LIVRE_TOKEN_URL ?? TOKEN_BASE_PADRAO, "MERCADO_LIVRE_TOKEN_URL", mercadoLivre);
  const app = origem(APP_URL, "APP_URL", /.*/);
  if (app.pathname !== "/" || app.search) throw new OAuthConfigurationError("APP_URL inválida.");
  return {
    clientId: MERCADO_LIVRE_APP_ID,
    clientSecret: MERCADO_LIVRE_APP_SECRET,
    authBase: authBase.toString(),
    tokenBase: tokenBase.toString(),
    // Precisa bater EXATAMENTE com o que está cadastrado na aplicação do ML.
    redirectUri: new URL("/api/integrations/mercadolivre/callback", app).toString(),
  };
}

// Para a tela decidir se oferece o botão: sem isto, o clique cairia num 500.
export function oauthConfigured() {
  try { oauthConfig(); return true; } catch { return false; }
}

export function authorizationUrl(state: string) {
  const config = oauthConfig();
  const url = new URL(config.authBase);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  externalAccountId: string;
}

function leiaTokenSet(corpo: unknown): TokenSet {
  if (!corpo || typeof corpo !== "object") throw new OrderError("Resposta de token inválida.");
  const dados = corpo as Record<string, unknown>;
  const accessToken = typeof dados.access_token === "string" ? dados.access_token : "";
  if (!accessToken) throw new OrderError("Resposta de token sem access_token.");
  const expiresIn = typeof dados.expires_in === "number" && Number.isFinite(dados.expires_in)
    ? dados.expires_in : null;
  // O user_id do vendedor é o que casa com o aviso; sem ele não há como
  // resolver qual conexão o evento pertence.
  const conta = dados.user_id;
  const externalAccountId = typeof conta === "number" ? String(conta)
    : typeof conta === "string" && conta.trim() ? conta.trim() : "";
  if (!externalAccountId) throw new OrderError("Resposta de token sem user_id.");
  return {
    accessToken,
    refreshToken: typeof dados.refresh_token === "string" && dados.refresh_token ? dados.refresh_token : null,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    externalAccountId,
  };
}

async function pedeToken(corpo: URLSearchParams, fetcher: typeof fetch) {
  const config = oauthConfig();
  const response = await fetcher(config.tokenBase, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: corpo,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  // Nenhuma mensagem carrega segredo, código ou corpo da resposta.
  if (response.status === 400 || response.status === 401) throw new ProviderAuthError("ML_OAUTH_REJECTED");
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("ML_OAUTH_UNAVAILABLE");
  if (!response.ok) throw new OrderError("Falha na autorização do Mercado Livre.");
  return leiaTokenSet(await response.json());
}

export async function exchangeCode(code: string, fetcher: typeof fetch = fetch) {
  const config = oauthConfig();
  if (!code.trim() || code.length > 500) throw new OrderError("Código de autorização inválido.");
  return pedeToken(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
  }), fetcher);
}

export async function refreshToken(refresh: string, fetcher: typeof fetch = fetch) {
  const config = oauthConfig();
  if (!refresh.trim()) throw new OrderError("Credencial de renovação ausente.");
  return pedeToken(new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refresh,
  }), fetcher);
}
