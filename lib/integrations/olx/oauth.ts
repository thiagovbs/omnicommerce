import "server-only";
import { objectInput, OrderError, textInput } from "../../domain/order-input";
import { ProviderTokens } from "../../services/connections";
import { ProviderAuthError, ProviderTransientError } from "../mercadolivre/client";
import { olxApiBase } from "./client";

/**
 * Autorização OAuth da OLX.
 *
 * Verificado na documentação pública: autorização em
 * `https://auth.olx.com.br/oauth`, token em `https://auth.olx.com.br/oauth/token`,
 * o código expira em 10 minutos e não se reusa, e os escopos são
 * `basic_user_info`, `autoupload`, `autoservice` e `chat`.
 *
 * Dois pontos NÃO documentados, e ambos com plano B declarado:
 *
 * 1. **Validade do access token.** A documentação não diz, e não há refresh
 *    token descrito. Então gravamos `expiresAt` nulo — que neste sistema
 *    significa "sem vencimento conhecido" — e o dia em que a OLX recusar por
 *    credencial, o erro vira reautorização. Inventar um prazo seria pior:
 *    curto demais reautoriza sem motivo, longo demais falha calado.
 * 2. **Suporte a `state`.** A documentação não menciona. Mandamos e exigimos de
 *    volta, porque é o que liga o retorno ao cookie desta sessão. Se a OLX não
 *    devolver, a autorização falha com mensagem específica em vez de aceitar um
 *    retorno que não se pode atribuir a ninguém.
 */

const AUTH_PADRAO = "https://auth.olx.com.br/oauth";
const TOKEN_PADRAO = "https://auth.olx.com.br/oauth/token";
/// Só o que a publicação precisa. Escopo a mais é rejeitado em homologação e,
/// pior, pede ao anunciante permissão que não vamos usar.
const ESCOPO_PADRAO = "basic_user_info autoupload";

export class OlxOAuthConfigurationError extends Error {}

function origem(valor: string, nome: string) {
  let url: URL;
  try { url = new URL(valor); } catch { throw new OlxOAuthConfigurationError(`${nome} inválida.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new OlxOAuthConfigurationError(`${nome} inválida.`);
  }
  // Só domínio da OLX, para configuração errada não virar redirecionamento
  // para host arbitrário.
  if (!/^([a-z0-9-]+\.)*olx\.com\.br$/.test(url.hostname)) {
    throw new OlxOAuthConfigurationError(`${nome} precisa ser um domínio da OLX.`);
  }
  return url.toString();
}

/// Credenciais do cliente OAuth da OLX, vindas do cadastro do canal.
export function olxOauthConfig(cfg: Record<string, string>) {
  const { APP_URL } = process.env;
  const ausentes = [
    cfg.clientId ? null : "Client ID",
    cfg.clientSecret ? null : "Client Secret",
  ].filter(Boolean);
  if (!APP_URL) throw new OlxOAuthConfigurationError("APP_URL não configurada neste deploy.");
  if (ausentes.length) {
    throw new OlxOAuthConfigurationError(
      `OAuth da OLX não configurado: ${ausentes.join(", ")}. Preencha na tela de Marketplaces.`);
  }
  const app = new URL(APP_URL);
  return {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    authBase: origem(cfg.authUrl || AUTH_PADRAO, "URL de autorização"),
    tokenBase: origem(cfg.tokenUrl || TOKEN_PADRAO, "URL de token"),
    // Precisa bater EXATAMENTE com uma das URIs cadastradas por e-mail junto do
    // suporte ao integrador: a OLX registra de uma a três, e não valida por
    // domínio. É por isso que o nonce da OLX vai em `state`, e não no caminho.
    redirectUri: new URL("/api/integrations/olx/callback", app).toString(),
    scope: (cfg.scope || ESCOPO_PADRAO).trim(),
  };
}

export function olxOauthConfigured(cfg: Record<string, string>) {
  try { olxOauthConfig(cfg); return true; } catch { return false; }
}

export function olxAuthorizationUrl(cfg: Record<string, string>, state: string) {
  const config = olxOauthConfig(cfg);
  const url = new URL(config.authBase);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  return url.toString();
}

async function pedirToken(
  cfg: Record<string, string>, corpo: URLSearchParams, fetcher: typeof fetch,
) {
  const config = olxOauthConfig(cfg);
  const response = await fetcher(config.tokenBase, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: corpo,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  // Nenhuma mensagem carrega segredo, código ou corpo da resposta.
  if (response.status === 400 || response.status === 401) throw new ProviderAuthError("OLX_OAUTH_REJECTED");
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("OLX_OAUTH_UNAVAILABLE");
  if (!response.ok) throw new OrderError("Falha na autorização da OLX.");

  const dados = objectInput(await response.json().catch(() => null));
  const accessToken = typeof dados.access_token === "string" ? dados.access_token : "";
  if (!accessToken) throw new OrderError("Resposta de token da OLX sem access_token.");
  const expiresIn = typeof dados.expires_in === "number" && Number.isFinite(dados.expires_in)
    ? dados.expires_in : null;
  return {
    accessToken,
    refreshToken: typeof dados.refresh_token === "string" && dados.refresh_token ? dados.refresh_token : null,
    // Nulo quando o provedor não diz: ver o ponto 1 do comentário do arquivo.
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    campos: Object.keys(dados).sort(),
    escopoConcedido: typeof dados.scope === "string" ? dados.scope : null,
  } satisfies ProviderTokens;
}

export async function exchangeOlxCode(
  cfg: Record<string, string>, code: string, fetcher: typeof fetch = fetch,
) {
  const config = olxOauthConfig(cfg);
  const codigo = textInput(code, "Código de autorização", 500);
  return pedirToken(cfg, new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: codigo,
    redirect_uri: config.redirectUri,
  }), fetcher);
}

/**
 * Quem autorizou.
 *
 * A conexão é única por (provedor, conta), e sem um identificador de conta não
 * há como saber se uma nova autorização é a mesma conta de antes ou outra. A
 * OLX não devolve isso no token, então vem do escopo `basic_user_info`.
 *
 * O caminho é configurável porque não pudemos confirmá-lo: se estiver errado, a
 * autorização falha com mensagem clara e se corrige por variável de ambiente.
 */
export async function fetchOlxUserInfo(
  cfg: Record<string, string>, token: string, fetcher: typeof fetch = fetch,
) {
  const caminho = cfg.userInfoPath || "/oauth_api/basic_user_info";
  const response = await fetcher(`${olxApiBase(cfg)}${caminho}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ access_token: token }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403) throw new ProviderAuthError("OLX_UNAUTHORIZED");
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("OLX_UNAVAILABLE");
  if (!response.ok) {
    throw new OrderError(
      "A OLX autorizou, mas não foi possível identificar a conta (basic_user_info)."
      + " Confirme o escopo e o caminho em OLX_USER_INFO_PATH.");
  }
  const dados = objectInput(await response.json().catch(() => null));
  const email = typeof dados.email === "string" ? dados.email.trim().toLowerCase() : "";
  const id = dados.user_id ?? dados.id;
  // O e-mail é o que a OLX garante no escopo; o id vem primeiro quando existe,
  // porque e-mail o anunciante pode trocar.
  const conta = (id === undefined || id === null || id === "" ? "" : String(id)) || email;
  if (!conta) throw new OrderError("A OLX não informou identificador nem e-mail da conta.");
  return {
    externalAccountId: conta.slice(0, 100),
    nome: typeof dados.name === "string" ? dados.name : null,
    email: email || null,
  };
}
