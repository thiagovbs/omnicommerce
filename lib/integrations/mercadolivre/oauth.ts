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
// offline_access é o que faz o provedor emitir refresh token, e é um valor do
// parâmetro scope da autorização — os permitidos são offline_access, read e
// write. O guia rápido do ML monta a URL sem escopo, mas ali o fluxo termina no
// access token; sem offline_access a conexão morre em seis horas.
//
// ATENÇÃO: o provedor só concede escopo novo em consentimento novo. Se a conta
// já autorizou a aplicação antes, é preciso revogar o acesso nas aplicações
// autorizadas do Mercado Livre — caso contrário ele reaproveita a autorização
// antiga e o escopo pedido aqui não tem efeito.
const SCOPE_PADRAO = "offline_access read write";

export class OAuthConfigurationError extends Error { override name = "OAuthConfigurationError"; }

function origem(valor: string, nome: string, permitidos: RegExp) {
  let url: URL;
  try { url = new URL(valor); } catch { throw new OAuthConfigurationError(`${nome} inválida.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      !permitidos.test(url.hostname)) {
    throw new OAuthConfigurationError(`${nome} inválida.`);
  }
  return url;
}

/**
 * Credenciais da aplicação do Mercado Livre, vindas da configuração do CANAL.
 *
 * Eram variáveis de ambiente, e isso dava uma aplicação só para todas as
 * organizações do mesmo deploy. Agora cada organização cadastra a dela na tela
 * de Marketplaces, e o que chega aqui é o conteúdo daquele cadastro.
 *
 * `APP_URL` continua no ambiente de propósito: é o endereço público DESTE
 * deploy, usado para montar o `redirect_uri`. É da instalação, não do tenant.
 */
export interface CredenciaisMercadoLivre {
  appId?: string;
  appSecret?: string;
  scope?: string;
  authUrl?: string;
  tokenUrl?: string;
}

export function oauthConfig(cred: CredenciaisMercadoLivre) {
  const { APP_URL } = process.env;
  if (!APP_URL) throw new OAuthConfigurationError("APP_URL não configurada neste deploy.");
  const ausentes = [
    cred.appId ? null : "App ID",
    cred.appSecret ? null : "App Secret",
  ].filter(Boolean);
  if (!cred.appId || !cred.appSecret) {
    throw new OAuthConfigurationError(
      `OAuth do Mercado Livre não configurado: ${ausentes.join(", ")}.`
      + " Preencha na tela de Marketplaces.");
  }
  // Só domínios do Mercado Livre, para configuração errada não virar
  // redirecionamento para host arbitrário.
  const mercadoLivre = /^([a-z0-9-]+\.)*mercado(livre|libre)\.com(\.[a-z]{2})?$/;
  const authBase = origem(cred.authUrl || AUTH_BASE_PADRAO, "URL de autorização", mercadoLivre);
  const tokenBase = origem(cred.tokenUrl || TOKEN_BASE_PADRAO, "URL de token", mercadoLivre);
  const app = origem(APP_URL, "APP_URL", /.*/);
  if (app.pathname !== "/" || app.search) throw new OAuthConfigurationError("APP_URL inválida.");
  return {
    clientId: cred.appId,
    clientSecret: cred.appSecret,
    authBase: authBase.toString(),
    tokenBase: tokenBase.toString(),
    // Precisa bater EXATAMENTE com o que está cadastrado na aplicação do ML.
    redirectUri: new URL("/api/integrations/mercadolivre/callback", app).toString(),
    // Ausente usa o padrão; VAZIO manda a autorização sem escopo, que é como
    // se reaproveita um consentimento já concedido. Os dois casos existem.
    scope: (cred.scope === undefined ? SCOPE_PADRAO : cred.scope).trim(),
  };
}

// Para a tela decidir se oferece o botão: sem isto, o clique cairia num 500.
export function oauthConfigured(cred: CredenciaisMercadoLivre) {
  try { oauthConfig(cred); return true; } catch { return false; }
}

export function authorizationUrl(state: string, cred: CredenciaisMercadoLivre) {
  const config = oauthConfig(cred);
  const url = new URL(config.authBase);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  if (config.scope) url.searchParams.set("scope", config.scope);
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  externalAccountId: string;
  /// Nomes dos campos que o provedor devolveu — nunca os valores. Serve para
  /// distinguir "o provedor não mandou refresh_token" de "o código o descartou",
  /// sem precisar espiar a resposta.
  campos: string[];
  /// Permissões concedidas, como o provedor as reporta. É lista de permissão,
  /// não credencial: sem offline_access ele não emite refresh token, e este é o
  /// único jeito de saber o que a aplicação realmente concedeu.
  escopoConcedido: string | null;
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
    campos: Object.keys(dados).sort(),
    escopoConcedido: typeof dados.scope === "string" ? dados.scope : null,
  };
}

async function pedeToken(
  corpo: URLSearchParams, cred: CredenciaisMercadoLivre, fetcher: typeof fetch,
) {
  const config = oauthConfig(cred);
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

export async function exchangeCode(
  code: string, cred: CredenciaisMercadoLivre, fetcher: typeof fetch = fetch,
) {
  const config = oauthConfig(cred);
  if (!code.trim() || code.length > 500) throw new OrderError("Código de autorização inválido.");
  return pedeToken(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
  }), cred, fetcher);
}

export async function refreshToken(
  refresh: string, cred: CredenciaisMercadoLivre, fetcher: typeof fetch = fetch,
) {
  const config = oauthConfig(cred);
  if (!refresh.trim()) throw new OrderError("Credencial de renovação ausente.");
  return pedeToken(new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refresh,
  }), cred, fetcher);
}
