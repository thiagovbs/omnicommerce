import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { objectInput, OrderError, textInput } from "../../domain/order-input";
import { ProviderAuthError, ProviderTransientError } from "../mercadolivre/client";

/**
 * Cliente da Open Platform da Shopee (API v2).
 *
 * ATENÇÃO, e isto vale para todo o adapter da Shopee: nada aqui foi medido
 * contra a API real. Criar app na Open Platform exige conta de desenvolvedor
 * aprovada e, no Brasil, CNPJ — o tipo "Individual Seller" está fechado para
 * BR. Então este código vem da documentação pública, e o que segue é o
 * inventário do que é FATO documentado e do que é decisão nossa:
 *
 * - Assinatura HMAC-SHA256 sobre uma string de base concatenada. Documentado.
 *   Em API pública a base é `partner_id + path + timestamp`; em API de loja
 *   entram também `access_token` e `shop_id`, nessa ordem. A ordem importa e é
 *   a fonte número um de erro de integração — por isso ela tem teste próprio,
 *   com vetor fixo.
 * - Erro dentro de HTTP 200. Documentado e traiçoeiro: a Shopee responde 200
 *   com `{"error": "error_auth", ...}`. Tratar `response.ok` como sucesso faria
 *   toda falha de credencial passar por publicação bem-sucedida.
 * - Hosts: produção `partner.shopeemobile.com`, sandbox
 *   `partner.test-stable.shopeemobile.com`. Configuráveis por ambiente, porque
 *   trocar de sandbox para produção não pode exigir deploy de código.
 * - Janela do timestamp: a documentação fala de 5 minutos para o link de
 *   autorização. Assumimos a mesma ordem de grandeza nas chamadas, o que só
 *   importa se o relógio do servidor estiver errado.
 */

/// Hosts oficiais. O sandbox é um host diferente, não um parâmetro: o mesmo
/// partner_id não vale nos dois.
const HOST_PRODUCAO = "https://partner.shopeemobile.com";
const HOST_SANDBOX = "https://partner.test-stable.shopeemobile.com";

export class ShopeeConfigurationError extends Error { override name = "ShopeeConfigurationError"; }

export interface ShopeeConfig {
  partnerId: string;
  partnerKey: string;
  host: string;
  /// Verdadeiro quando se está falando com o sandbox. Aparece em log e na tela
  /// para ninguém confundir anúncio de teste com anúncio de verdade.
  sandbox: boolean;
}

/**
 * Configuração da aplicação Shopee, vinda do cadastro do CANAL.
 *
 * Era variável de ambiente, e por isso uma aplicação servia todas as
 * organizações do mesmo deploy. Agora cada organização cadastra o partner dela
 * na tela de Marketplaces, e `cfg` é o conteúdo daquele cadastro.
 */
export function shopeeConfig(cfg: Record<string, string>): ShopeeConfig {
  const ausentes = [
    cfg.partnerId ? null : "Partner ID",
    cfg.partnerKey ? null : "Partner Key",
  ].filter(Boolean);
  if (ausentes.length) {
    throw new ShopeeConfigurationError(
      `Shopee não configurada: ${ausentes.join(", ")}. Preencha na tela de Marketplaces.`);
  }
  // O partner_id entra na assinatura como número e na URL como texto: se vier
  // com espaço ou letra, a assinatura sai diferente da que o provedor calcula
  // e o erro chega como "error_sign", que não diz nada sobre a causa.
  if (!/^\d{1,20}$/.test(cfg.partnerId)) {
    throw new ShopeeConfigurationError("Partner ID deve ser numérico.");
  }
  const sandbox = cfg.sandbox === "true";
  const host = (cfg.host || (sandbox ? HOST_SANDBOX : HOST_PRODUCAO)).replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(host); } catch { throw new ShopeeConfigurationError("Host da API inválido."); }
  if (url.protocol !== "https:" || url.search || url.hash || url.username) {
    throw new ShopeeConfigurationError("Host da API inválido.");
  }
  return { partnerId: cfg.partnerId, partnerKey: cfg.partnerKey, host, sandbox };
}

/// Para a tela decidir se oferece o botão, em vez de deixar o clique cair num 500.
export function shopeeConfigured(cfg: Record<string, string>) {
  try { shopeeConfig(cfg); return true; } catch { return false; }
}

/**
 * Assinatura de uma chamada.
 *
 * A string de base é concatenação simples, sem separador: `partner_id`, o
 * caminho da API, o timestamp e — só em chamada de loja — o access token e o
 * shop_id. Qualquer campo fora de ordem produz uma assinatura válida em forma
 * e errada em valor, e o provedor responde `error_sign` sem dizer qual parte
 * divergiu.
 */
export function assinarShopee(
  config: Pick<ShopeeConfig, "partnerId" | "partnerKey">, path: string, timestamp: number,
  loja?: { accessToken: string; shopId: string },
) {
  const base = `${config.partnerId}${path}${timestamp}`
    + (loja ? `${loja.accessToken}${loja.shopId}` : "");
  return createHmac("sha256", config.partnerKey).update(base).digest("hex");
}

/// Segundos, que é o que a Shopee usa em timestamp e em janelas de data.
export function agoraEmSegundos() {
  return Math.floor(Date.now() / 1000);
}

function urlAssinada(
  config: ShopeeConfig, path: string, loja?: { accessToken: string; shopId: string },
  extra: Record<string, string> = {},
) {
  const timestamp = agoraEmSegundos();
  const url = new URL(config.host + path);
  url.searchParams.set("partner_id", config.partnerId);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", assinarShopee(config, path, timestamp, loja));
  if (loja) {
    url.searchParams.set("access_token", loja.accessToken);
    url.searchParams.set("shop_id", loja.shopId);
  }
  for (const [chave, valor] of Object.entries(extra)) url.searchParams.set(chave, valor);
  return url.toString();
}

/// Credencial de uma loja autorizada. `shopId` é o `externalAccountId` da
/// conexão: é por ele que o aviso de pedido encontra o tenant.
export interface ShopeeCredenciais {
  accessToken: string;
  shopId: string;
}

/**
 * Códigos de erro que não melhoram com o tempo.
 *
 * A separação existe porque o trabalhador trata as duas classes de forma
 * oposta: erro de credencial vira reautorização, erro temporário vira nova
 * tentativa com backoff. Sem a lista, tudo seria temporário e um anúncio
 * recusado para sempre consumiria as oito tentativas.
 */
const ERROS_DE_CREDENCIAL = new Set([
  "error_auth", "error_permission", "error_token_expired", "error_shop_not_auth",
  "error_invalid_access_token", "error_sign",
]);
const ERROS_TEMPORARIOS = new Set([
  "error_server", "error_busy", "error_network", "error_timeout",
]);

/**
 * Lê a resposta da Shopee, que reporta erro DENTRO de HTTP 200.
 *
 * `error` vazio é sucesso; qualquer outra coisa é falha, e a mensagem dela é
 * informação de domínio — é o que diz qual campo do anúncio o provedor
 * recusou. Não carrega credencial, mas vem cortada porque pode vir longa.
 */
export async function lerRespostaShopee(response: Response, oQueFalhou: string) {
  if (response.status === 401 || response.status === 403) throw new ProviderAuthError("SHOPEE_UNAUTHORIZED");
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("SHOPEE_UNAVAILABLE");
  if (!response.ok) throw new OrderError(`${oQueFalhou}.`);

  const corpo = objectInput(await response.json().catch(() => null));
  const erro = typeof corpo.error === "string" ? corpo.error : "";
  if (!erro) return corpo;

  if (ERROS_DE_CREDENCIAL.has(erro)) throw new ProviderAuthError("SHOPEE_UNAUTHORIZED");
  if (ERROS_TEMPORARIOS.has(erro)) throw new ProviderTransientError("SHOPEE_UNAVAILABLE");
  const motivo = typeof corpo.message === "string" && corpo.message ? corpo.message : erro;
  throw new OrderError(`${oQueFalhou}: ${motivo.slice(0, 300)}`);
}

/// O corpo útil vem embrulhado em `response`. Ausência dele é resposta que não
/// entendemos, e não sucesso vazio.
export function conteudoShopee(corpo: Record<string, unknown>, oQueFalhou: string) {
  if (!corpo.response || typeof corpo.response !== "object" || Array.isArray(corpo.response)) {
    throw new OrderError(`${oQueFalhou}: resposta sem conteúdo.`);
  }
  return corpo.response as Record<string, unknown>;
}

export async function chamarShopee(
  cfg: Record<string, string>,
  path: string,
  opcoes: {
    metodo?: "GET" | "POST";
    loja?: ShopeeCredenciais;
    corpo?: unknown;
    query?: Record<string, string>;
    oQueFalhou: string;
    timeoutMs?: number;
    /// A maioria das rotas embrulha o resultado em `response`. As de token e a
    /// de dados da loja devolvem os campos na raiz -- documentado, e é o tipo
    /// de assimetria que só aparece quando a primeira chamada real falha com
    /// "resposta sem conteúdo". Por isso é explícito aqui.
    envelope?: boolean;
  },
  fetcher: typeof fetch = fetch,
) {
  const config = shopeeConfig(cfg);
  const metodo = opcoes.metodo ?? "GET";
  const response = await fetcher(urlAssinada(config, path, opcoes.loja, opcoes.query ?? {}), {
    method: metodo,
    headers: {
      Accept: "application/json",
      ...(metodo === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(metodo === "POST" ? { body: JSON.stringify(opcoes.corpo ?? {}) } : {}),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(opcoes.timeoutMs ?? 20000),
  });
  const corpo = await lerRespostaShopee(response, opcoes.oQueFalhou);
  if (opcoes.envelope === false) return corpo;
  return conteudoShopee(corpo, opcoes.oQueFalhou);
}

/**
 * Confere a assinatura de um aviso recebido.
 *
 * A Shopee assina o push no header `Authorization`, com HMAC-SHA256 sobre a
 * URL de callback concatenada ao corpo CRU. Tem de ser o corpo cru: reserializar
 * o JSON reordena chaves e muda espaços, e a assinatura passa a não bater por
 * um motivo que não aparece em lugar nenhum.
 */
export function assinaturaDePushValida(
  cfg: Record<string, string>, url: string, corpoCru: string, assinatura: string,
) {
  let config: ShopeeConfig;
  try { config = shopeeConfig(cfg); } catch { return false; }
  const esperada = createHmac("sha256", config.partnerKey).update(url + corpoCru).digest("hex");
  const a = Buffer.from(assinatura.trim().toLowerCase());
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Pedido, pelo número que o aviso trouxe.
 *
 * `order_sn` é o identificador da Shopee e é texto, não número — por isso o
 * `externalOrderId` do evento é guardado como texto em todo o sistema.
 */
export async function fetchShopeeOrder(
  cfg: Record<string, string>, loja: ShopeeCredenciais, orderSn: string,
  fetcher: typeof fetch = fetch,
) {
  const numero = textInput(orderSn, "Pedido externo", 80);
  const conteudo = await chamarShopee(cfg, "/api/v2/order/get_order_detail", {
    loja,
    query: {
      order_sn_list: numero,
      // Sem os campos opcionais o detalhe vem sem itens, e sem itens não há
      // como baixar estoque.
      response_optional_fields: "item_list,total_amount,payment_method,buyer_username,recipient_address",
    },
    oQueFalhou: "Falha ao consultar o pedido na Shopee",
  }, fetcher);

  const lista = Array.isArray(conteudo.order_list) ? conteudo.order_list : [];
  if (!lista.length) throw new OrderError("Pedido não encontrado na Shopee.");
  return lista[0] as unknown;
}

/**
 * O que mudou desde uma data, para a conciliação.
 *
 * A janela da Shopee é fechada em 15 dias e obrigatória nos dois lados, então
 * pedir "tudo desde ontem" exige `time_from` e `time_to`. A conciliação chama
 * isto com a própria marca d'água, que já tem sobreposição.
 */
export async function listChangedShopeeOrders(
  cfg: Record<string, string>, loja: ShopeeCredenciais, desde: Date,
  fetcher: typeof fetch = fetch,
) {
  const JANELA_MAXIMA_S = 15 * 24 * 60 * 60;
  const agora = agoraEmSegundos();
  const inicio = Math.max(Math.floor(desde.getTime() / 1000), agora - JANELA_MAXIMA_S);

  const alterados: { externalOrderId: string; updatedAt: Date }[] = [];
  let cursor = "";
  // Paginação por cursor, com teto: sem o teto, uma resposta que sempre diz
  // "tem mais" prenderia a rodada da conciliação para sempre.
  for (let pagina = 0; pagina < 20; pagina++) {
    const conteudo = await chamarShopee(cfg, "/api/v2/order/get_order_list", {
      loja,
      query: {
        time_range_field: "update_time",
        time_from: String(inicio),
        time_to: String(agora),
        page_size: "100",
        ...(cursor ? { cursor } : {}),
      },
      oQueFalhou: "Falha ao listar pedidos na Shopee",
    }, fetcher);

    for (const cru of Array.isArray(conteudo.order_list) ? conteudo.order_list : []) {
      const linha = objectInput(cru);
      const externalOrderId = textInput(linha.order_sn, "Pedido na listagem da Shopee", 80);
      // A listagem pode vir sem update_time; nesse caso o carimbo é o fim da
      // janela, que é o que sabemos com certeza: mudou antes de agora.
      const segundos = typeof linha.update_time === "number" ? linha.update_time : agora;
      alterados.push({ externalOrderId, updatedAt: new Date(segundos * 1000) });
    }

    cursor = typeof conteudo.next_cursor === "string" ? conteudo.next_cursor : "";
    if (conteudo.more !== true || !cursor) break;
  }
  return alterados;
}
