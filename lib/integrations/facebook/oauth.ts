import "server-only";
import { objectInput, OrderError, textInput } from "../../domain/order-input";
import { ProviderTokens } from "../../services/connections";
import { ProviderAuthError, ProviderTransientError } from "../mercadolivre/client";
import { facebookAuthBase, facebookGraphBase, FacebookConfigurationError } from "./client";

/**
 * Autorização da Meta (Facebook Login for Business).
 *
 * Verificado na documentação pública: diálogo em
 * `https://www.facebook.com/v{versão}/dialog/oauth`, troca do código em
 * `GET https://graph.facebook.com/v{versão}/oauth/access_token`, recusa
 * voltando na URL como `error`/`error_reason`/`error_description`, e a troca do
 * token curto pelo de longa duração com `grant_type=fb_exchange_token`.
 *
 * **Não há refresh token.** O token longo dura cerca de 60 dias e, quando
 * vence, a única saída documentada é a pessoa autorizar de novo -- um token
 * expirado não serve nem para pedir outro. Então aqui:
 *
 * - a troca pelo token longo acontece NA HORA da autorização, e não depois:
 *   adiar significaria guardar um token de uma hora e descobrir o problema
 *   quando ele já não pudesse ser trocado;
 * - `expiresAt` é gravado com o que a Meta informa, e a publicação recusa
 *   credencial vencida pedindo reautorização, em vez de tentar renovar o que
 *   não se renova.
 *
 * O escopo que importa é `catalog_management`: sem ele o token entra, a
 * conexão fica ativa e TODA publicação volta como falta de permissão -- falha
 * tardia e confusa. Por isso o escopo concedido é conferido aqui, na
 * autorização, que é onde se corrige.
 */

/// Sem isto o token não escreve no catálogo, e a conexão nasceria inútil.
const ESCOPO_OBRIGATORIO = "catalog_management";

export class FacebookOAuthConfigurationError extends Error { override name = "FacebookOAuthConfigurationError"; }

export function facebookOauthConfig(cfg: Record<string, string>) {
  const { APP_URL } = process.env;
  const ausentes = [
    cfg.appId ? null : "App ID",
    cfg.appSecret ? null : "App Secret",
    cfg.catalogId ? null : "ID do catálogo",
  ].filter(Boolean);
  if (!APP_URL) throw new FacebookOAuthConfigurationError("APP_URL não configurada neste deploy.");
  if (ausentes.length) {
    throw new FacebookOAuthConfigurationError(
      `OAuth do Facebook não configurado: ${ausentes.join(", ")}. Preencha na tela de Marketplaces.`);
  }
  let authBase: string;
  let graphBase: string;
  try {
    authBase = facebookAuthBase(cfg);
    graphBase = facebookGraphBase(cfg);
  } catch (error) {
    // A configuração inválida do endereço é do mesmo tipo de problema que a
    // credencial faltando: se corrige na tela, não em código.
    throw new FacebookOAuthConfigurationError(
      error instanceof FacebookConfigurationError ? error.message : "Configuração do Facebook inválida.");
  }
  return {
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    authBase,
    graphBase,
    // Precisa estar cadastrada em "URIs de redirecionamento do OAuth válidos"
    // no painel do aplicativo: a Meta compara a URI inteira.
    redirectUri: new URL("/api/integrations/facebook/callback", new URL(APP_URL)).toString(),
    scope: (cfg.scope || "catalog_management,business_management").trim(),
  };
}

export function facebookOauthConfigured(cfg: Record<string, string>) {
  try { facebookOauthConfig(cfg); return true; } catch { return false; }
}

export function facebookAuthorizationUrl(cfg: Record<string, string>, state: string) {
  const config = facebookOauthConfig(cfg);
  const url = new URL(`${config.authBase}/dialog/oauth`);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  return url.toString();
}

/// Escopos concedidos, como a Meta os escreve (vírgula ou espaço).
function escopos(texto: string | null | undefined) {
  return new Set((texto ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
}

async function pedirToken(
  cfg: Record<string, string>, parametros: URLSearchParams, fetcher: typeof fetch,
): Promise<ProviderTokens> {
  const config = facebookOauthConfig(cfg);
  const url = new URL(`${config.graphBase}/oauth/access_token`);
  // A troca do código é GET na Graph API; o segredo vai na query porque é o
  // que o contrato define, e o destino é o host da Meta, por HTTPS.
  parametros.forEach((valor, chave) => url.searchParams.set(chave, valor));

  const response = await fetcher(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  // Nenhuma mensagem daqui carrega segredo, código ou corpo da resposta.
  if (response.status === 400 || response.status === 401) {
    throw new ProviderAuthError("FACEBOOK_OAUTH_REJECTED");
  }
  if (response.status === 429 || response.status >= 500) {
    throw new ProviderTransientError("FACEBOOK_OAUTH_UNAVAILABLE");
  }
  if (!response.ok) throw new OrderError("Falha na autorização do Facebook.");

  const dados = objectInput(await response.json().catch(() => null));
  const accessToken = typeof dados.access_token === "string" ? dados.access_token : "";
  if (!accessToken) throw new OrderError("Resposta de token do Facebook sem access_token.");
  // A Meta documenta `expires_in` como texto no exemplo e como número em
  // outros pontos; os dois são aceitos, e o que não for número vira nulo.
  const bruto = dados.expires_in;
  const segundos = typeof bruto === "number" ? bruto
    : typeof bruto === "string" && bruto.trim() ? Number(bruto) : NaN;
  const expiresIn = Number.isFinite(segundos) && segundos > 0 ? segundos : null;
  return {
    accessToken,
    // A Meta não emite refresh token para token de usuário: quando o longo
    // vence, a pessoa autoriza de novo.
    refreshToken: null,
    // Nulo quando ela não diz: neste sistema significa "sem vencimento
    // conhecido", e a recusa do provedor vira reautorização.
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    campos: Object.keys(dados).sort(),
    escopoConcedido: typeof dados.scope === "string" ? dados.scope : null,
  } satisfies ProviderTokens;
}

/**
 * Troca o código pelo token e, na mesma ida, pelo de longa duração.
 *
 * São duas chamadas porque a Meta faz assim: o código vira um token de cerca
 * de uma hora, e só ele pode ser trocado pelo de 60 dias. Fazer isso depois
 * seria tarde -- o curto já teria vencido.
 */
export async function exchangeFacebookCode(
  cfg: Record<string, string>, code: string, fetcher: typeof fetch = fetch,
) {
  const config = facebookOauthConfig(cfg);
  const codigo = textInput(code, "Código de autorização", 1000);
  const curto = await pedirToken(cfg, new URLSearchParams({
    client_id: config.appId,
    client_secret: config.appSecret,
    redirect_uri: config.redirectUri,
    code: codigo,
  }), fetcher);

  const longo = await pedirToken(cfg, new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: config.appId,
    client_secret: config.appSecret,
    fb_exchange_token: curto.accessToken,
  }), fetcher);

  // O escopo vem da primeira resposta quando vem; a segunda troca não o
  // repete. Preservar o que foi concedido é o que permite conferi-lo abaixo.
  return { ...longo, escopoConcedido: longo.escopoConcedido ?? curto.escopoConcedido };
}

/**
 * Quem autorizou, e se autorizou o suficiente.
 *
 * A conexão é única por (provedor, conta), e sem identificador de conta não há
 * como saber se esta autorização é a mesma de antes ou outra -- e autorizar a
 * partir da linha errada MOVERIA a conexão de canal.
 *
 * A conferência do escopo mora aqui, e não na publicação: recusar agora custa
 * uma frase na tela de quem está autorizando; recusar depois seria uma falha
 * por anúncio, dias mais tarde, sem ligação visível com a causa.
 */
export async function fetchFacebookAccount(
  cfg: Record<string, string>, tokens: ProviderTokens, fetcher: typeof fetch = fetch,
) {
  const concedidos = escopos(tokens.escopoConcedido);
  if (concedidos.size && !concedidos.has(ESCOPO_OBRIGATORIO)) {
    throw new OrderError(
      `A autorização não incluiu a permissão ${ESCOPO_OBRIGATORIO}, sem a qual não é`
      + " possível publicar no catálogo. Autorize de novo marcando o acesso ao catálogo.");
  }

  const url = new URL(`${facebookGraphBase(cfg)}/me`);
  url.searchParams.set("fields", "id,name");
  const response = await fetcher(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new ProviderAuthError("FACEBOOK_UNAUTHORIZED");
  }
  if (response.status === 429 || response.status >= 500) {
    throw new ProviderTransientError("FACEBOOK_UNAVAILABLE");
  }
  if (!response.ok) {
    throw new OrderError("O Facebook autorizou, mas não foi possível identificar a conta.");
  }
  const dados = objectInput(await response.json().catch(() => null));
  const id = dados.id === undefined || dados.id === null ? "" : String(dados.id);
  if (!id) throw new OrderError("O Facebook não informou o identificador da conta.");
  return {
    externalAccountId: id.slice(0, 100),
    nome: typeof dados.name === "string" ? dados.name : null,
  };
}
