import "server-only";
import { objectInput, OrderError, textInput } from "../../domain/order-input";
import { ProviderTokens } from "../../services/connections";
import { agoraEmSegundos, assinarShopee, chamarShopee, shopeeConfig } from "./client";

/**
 * Autorização de loja na Shopee.
 *
 * Três diferenças em relação ao Mercado Livre, todas com consequência no
 * desenho:
 *
 * 1. Não existe parâmetro `state`. O provedor devolve `code` e `shop_id`
 *    colados na URL de redirecionamento, e ponto. Então o nosso nonce viaja no
 *    CAMINHO do callback (`/callback/{nonce}`), não na query: assim não há
 *    ambiguidade sobre como o provedor junta os parâmetros dele aos nossos.
 *    O cookie cifrado continua sendo quem prova organização e canal.
 * 2. A autorização é por LOJA. O `shop_id` que volta é o
 *    `externalAccountId` da conexão, e é ele que liga um aviso de pedido ao
 *    tenant certo.
 * 3. Há renovação de verdade: `access_token` de 4 horas e `refresh_token` de
 *    30 dias, com autorização de até 365 dias. É o oposto do que vivemos no
 *    Mercado Livre, onde sem `offline_access` a conexão morre em 6 horas e
 *    alguém precisa reautorizar à mão.
 *
 * Nada disto foi medido: criar o app exige conta de desenvolvedor aprovada com
 * CNPJ. O fluxo vem da documentação, e o host é configurável para que um
 * palpite errado se corrija por variável de ambiente, sem deploy.
 */

const CAMINHO_AUTORIZACAO = "/api/v2/shop/auth_partner";
const CAMINHO_TOKEN = "/api/v2/auth/token/get";
const CAMINHO_RENOVACAO = "/api/v2/auth/access_token/get";

export function shopeeRedirectUri(nonce: string) {
  const app = process.env.APP_URL;
  if (!app) throw new OrderError("APP_URL não configurada.");
  // O nonce no caminho, e não na query: ver o item 1 do comentário acima.
  return new URL(`/api/integrations/shopee/callback/${encodeURIComponent(nonce)}`, app).toString();
}

export function shopeeAuthorizationUrl(cfg: Record<string, string>, nonce: string) {
  const config = shopeeConfig(cfg);
  const timestamp = agoraEmSegundos();
  const url = new URL(config.host + CAMINHO_AUTORIZACAO);
  url.searchParams.set("partner_id", config.partnerId);
  url.searchParams.set("timestamp", String(timestamp));
  // A assinatura do link é de API pública: sem token e sem loja, que é o que
  // faz sentido — ninguém tem credencial antes de autorizar.
  url.searchParams.set("sign", assinarShopee(config, CAMINHO_AUTORIZACAO, timestamp));
  url.searchParams.set("redirect", shopeeRedirectUri(nonce));
  return url.toString();
}

/// O `shop_id` vem do provedor na volta e precisa ser numérico: ele entra na
/// assinatura de toda chamada de loja, e um valor estranho ali produz
/// `error_sign`, que não explica nada.
export function lerShopId(valor: unknown) {
  const texto = typeof valor === "number" ? String(valor) : textInput(valor, "Loja", 30);
  if (!/^\d{1,20}$/.test(texto)) throw new OrderError("Identificador de loja inválido.");
  return texto;
}

function lerTokens(conteudo: Record<string, unknown>, shopId: string): ProviderTokens & { externalAccountId: string } {
  const accessToken = typeof conteudo.access_token === "string" ? conteudo.access_token : "";
  if (!accessToken) throw new OrderError("Resposta da Shopee sem access_token.");
  const expiraEm = typeof conteudo.expire_in === "number" && Number.isFinite(conteudo.expire_in)
    ? conteudo.expire_in : null;
  return {
    accessToken,
    refreshToken: typeof conteudo.refresh_token === "string" && conteudo.refresh_token
      ? conteudo.refresh_token : null,
    expiresAt: expiraEm ? new Date(Date.now() + expiraEm * 1000) : null,
    externalAccountId: shopId,
    // Nomes, nunca valores: é o que permite distinguir "o provedor não mandou
    // refresh_token" de "o nosso código o descartou".
    campos: Object.keys(conteudo).sort(),
    // A Shopee não reporta escopo no token; a permissão é do tipo de app,
    // decidida no console. Nulo declarado, para não parecer esquecimento.
    escopoConcedido: null,
  };
}

/**
 * Troca o código pela credencial da loja.
 *
 * O `shop_id` NÃO sai da resposta: ele vem na volta do redirecionamento e é
 * entrada aqui. A chamada é de API pública — a assinatura não leva token,
 * porque token é justamente o que se está pedindo.
 */
export async function exchangeShopeeCode(
  cfg: Record<string, string>, code: string, shopId: string, fetcher: typeof fetch = fetch,
) {
  const config = shopeeConfig(cfg);
  const codigo = textInput(code, "Código de autorização", 500);
  const loja = lerShopId(shopId);
  const conteudo = await chamarShopee(cfg, CAMINHO_TOKEN, {
    metodo: "POST",
    corpo: { code: codigo, shop_id: Number(loja), partner_id: Number(config.partnerId) },
    oQueFalhou: "Falha na autorização da Shopee",
    envelope: false,
  }, fetcher);
  return lerTokens(conteudo, loja);
}

/**
 * Renova antes das 4 horas, com o refresh token de 30 dias.
 *
 * A Shopee devolve um refresh_token novo a cada renovação, e o antigo deixa de
 * valer. Guardar o novo não é opcional: perder essa gravação transforma uma
 * autorização de 365 dias numa de 30.
 */
export async function refreshShopeeToken(
  cfg: Record<string, string>, refresh: string, shopId: string, fetcher: typeof fetch = fetch,
) {
  const config = shopeeConfig(cfg);
  const credencial = textInput(refresh, "Credencial de renovação", 500);
  const loja = lerShopId(shopId);
  const conteudo = await chamarShopee(cfg, CAMINHO_RENOVACAO, {
    metodo: "POST",
    corpo: { refresh_token: credencial, shop_id: Number(loja), partner_id: Number(config.partnerId) },
    oQueFalhou: "Falha ao renovar a credencial da Shopee",
    envelope: false,
  }, fetcher);
  return lerTokens(conteudo, loja);
}

/// Lê `code` e `shop_id` da volta do provedor. Separado para ter teste: é o
/// ponto em que um parâmetro ausente precisa virar mensagem, e não exceção crua.
export function lerRetornoDeAutorizacao(params: URLSearchParams) {
  const code = params.get("code") ?? "";
  if (!code) throw new OrderError("Autorização da Shopee sem código.");
  const shopId = params.get("shop_id") ?? "";
  if (!shopId) {
    // A Shopee também autoriza a partir de conta principal (merchant), e aí
    // vem `main_account_id` em vez de `shop_id`, com uma lista de lojas. Isso
    // não está implementado, e é melhor dizer o que falta do que cair num erro
    // genérico de parâmetro.
    if (params.get("main_account_id")) {
      throw new OrderError(
        "Esta autorização veio de uma conta principal (merchant), que ainda não é"
        + " suportada. Autorize a partir da conta da loja.");
    }
    throw new OrderError("Autorização da Shopee sem identificador de loja.");
  }
  return { code: textInput(code, "Código de autorização", 500), shopId: lerShopId(shopId) };
}

/// Dados da loja, para mostrar de quem é a conexão. Não é crítico ao fluxo:
/// falhar aqui não deve impedir gravar a credencial que já foi obtida.
export async function fetchShopeeShopInfo(
  cfg: Record<string, string>, loja: { accessToken: string; shopId: string },
  fetcher: typeof fetch = fetch,
) {
  const conteudo = await chamarShopee(cfg, "/api/v2/shop/get_shop_info", {
    loja, oQueFalhou: "Falha ao consultar a loja na Shopee", envelope: false,
  }, fetcher);
  const dados = objectInput(conteudo);
  return {
    nome: typeof dados.shop_name === "string" ? dados.shop_name : null,
    regiao: typeof dados.region === "string" ? dados.region : null,
  };
}
