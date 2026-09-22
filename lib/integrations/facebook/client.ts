import "server-only";
import { objectInput, OrderError } from "../../domain/order-input";
import { ProviderAuthError, ProviderTransientError } from "../mercadolivre/client";

/**
 * Cliente do catálogo do Meta (Graph API).
 *
 * **O que este canal é, e o que ele não é.** Não existe API pública para
 * anunciar no Marketplace: a de parceiros é fechada e sai por aprovação
 * comercial. O que existe e é aberto é o CATÁLOGO do Commerce Manager, e é
 * nele que este adapter escreve. O produto publicado aqui aparece na loja do
 * Facebook e do Instagram; no Marketplace, só para quem está no programa de
 * parceiros -- e aí o catálogo já é a fonte. Dizer isto em código evita a
 * promessa que a tela faria sozinha ao mostrar "Facebook" na lista de canais.
 *
 * Como a OLX, é canal só de PUBLICAÇÃO: não há API de pedido para nós aqui
 * (o checkout do Meta é dos Estados Unidos, e a venda do Marketplace acontece
 * na conversa entre as pessoas). Conciliação e resolução de pedido recusam com
 * essa frase, em vez de "não implementado".
 *
 * **Duas particularidades da Graph API que mudam o desenho:**
 *
 * 1. **A gravação é assíncrona.** `items_batch` valida a forma e devolve um
 *    `handle`; o destino de cada item sai depois, em
 *    `check_batch_request_status`. Mesma forma da OLX, e o mesmo cuidado: uma
 *    consulta só, sem espera.
 * 2. **A versão entra no CAMINHO.** `/v23.0/...`. Uma versão aposentada
 *    responde erro em toda chamada, então ela é configuração de canal e não
 *    constante -- trocar não pode exigir deploy.
 *
 * O contrato aqui é documentação pública verificada
 * (developers.facebook.com/docs/marketing-api/catalog-batch), mas **nada foi
 * exercitado contra a API real**: não há aplicativo Meta aprovado nem catálogo
 * a que falar. Os pontos em que a documentação é vaga estão marcados onde
 * aparecem.
 */

const GRAPH_PADRAO = "https://graph.facebook.com";
const AUTH_PADRAO = "https://www.facebook.com";
const VERSAO_PADRAO = "v23.0";

/// Teto declarado do corpo de `items_batch`.
const LIMITE_CORPO_BYTES = 28 * 1024 * 1024;

export class FacebookConfigurationError extends Error { override name = "FacebookConfigurationError"; }

function baseDaMeta(bruto: string, nome: string) {
  let url: URL;
  try { url = new URL(bruto); } catch { throw new FacebookConfigurationError(`${nome} inválida.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new FacebookConfigurationError(`${nome} inválida.`);
  }
  // Só domínio da Meta: configuração errada aqui mandaria token para host
  // arbitrário, e é justamente o token que não pode sair de casa.
  if (!/^([a-z0-9-]+\.)*(facebook\.com|fb\.com)$/.test(url.hostname)) {
    throw new FacebookConfigurationError(`${nome} precisa ser um domínio da Meta.`);
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/// Versão da Graph API, como ela entra no caminho.
export function facebookApiVersion(cfg: Record<string, string>) {
  const versao = (cfg.apiVersion || VERSAO_PADRAO).trim();
  if (!/^v\d{1,3}\.\d{1,3}$/.test(versao)) {
    throw new FacebookConfigurationError("Versão da Graph API inválida (use o formato v23.0).");
  }
  return versao;
}

/// Base das chamadas de dados, já com a versão.
export function facebookGraphBase(cfg: Record<string, string>) {
  return `${baseDaMeta(cfg.graphUrl || GRAPH_PADRAO, "URL da Graph API")}/${facebookApiVersion(cfg)}`;
}

/// Base do diálogo de autorização, já com a versão.
export function facebookAuthBase(cfg: Record<string, string>) {
  return `${baseDaMeta(cfg.authUrl || AUTH_PADRAO, "URL de autorização")}/${facebookApiVersion(cfg)}`;
}

/// O catálogo que recebe os produtos. Só dígitos: o id da Meta é numérico, e
/// um valor com caminho ou query entraria na montagem da URL.
export function facebookCatalogId(cfg: Record<string, string>) {
  const id = (cfg.catalogId || "").trim();
  if (!/^\d{1,30}$/.test(id)) {
    throw new FacebookConfigurationError(
      "ID do catálogo inválido: use o número que aparece no Commerce Manager.");
  }
  return id;
}

/**
 * Erro da Graph API traduzido para a classe que decide o que o trabalhador faz.
 *
 * A Meta responde `{"error": {...}}` com HTTP 400 em quase tudo -- inclusive em
 * token inválido e em excesso de chamadas -- então o status sozinho não separa
 * "tentar de novo" de "corrigir o cadastro". Quem separa são os códigos:
 *
 * - `190` é token (expirado, revogado, inválido) e vira reautorização;
 * - `4`, `17`, `32`, `613` e `80004` são limites de chamada, que passam;
 * - `2` e `1` são falha interna/desconhecida, que também passa;
 * - o resto é problema do que mandamos, e repetir só queima as tentativas.
 */
const CODIGOS_DE_AUTORIZACAO = new Set([102, 190, 200, 10, 3]);
const CODIGOS_TEMPORARIOS = new Set([1, 2, 4, 17, 32, 341, 613, 80004]);

function traduzirErro(corpo: Record<string, unknown>, oQueFalhou: string): never {
  const erro = objectInput(corpo.error ?? {});
  const codigo = typeof erro.code === "number" ? erro.code : null;
  if (codigo !== null && CODIGOS_DE_AUTORIZACAO.has(codigo)) {
    throw new ProviderAuthError("FACEBOOK_UNAUTHORIZED");
  }
  if (codigo !== null && CODIGOS_TEMPORARIOS.has(codigo)) {
    throw new ProviderTransientError("FACEBOOK_UNAVAILABLE");
  }
  // A mensagem da Meta nomeia o campo recusado, que é o que ajuda quem
  // cadastrou. `error_user_msg` é a versão escrita para pessoas, quando existe.
  const detalhe = [erro.error_user_msg, erro.message]
    .find((m) => typeof m === "string" && m) as string | undefined;
  throw new OrderError(detalhe ? `${oQueFalhou}: ${detalhe.slice(0, 300)}` : `${oQueFalhou}.`);
}

async function lerResposta(response: Response, oQueFalhou: string) {
  const corpo = objectInput(await response.json().catch(() => null));
  // O corpo de erro vem mesmo em 200 quando a Meta reclama de sub-requisição,
  // então ele é conferido antes do status.
  if (corpo.error) traduzirErro(corpo, oQueFalhou);
  if (response.status === 401 || response.status === 403) {
    throw new ProviderAuthError("FACEBOOK_UNAUTHORIZED");
  }
  if (response.status === 429 || response.status >= 500) {
    throw new ProviderTransientError("FACEBOOK_UNAVAILABLE");
  }
  if (!response.ok) throw new OrderError(`${oQueFalhou}.`);
  return corpo;
}

/// O que a Meta reclamou de um item, já achatado em texto.
export interface AvisoDoCatalogo {
  retailerId: string | null;
  erros: string[];
  avisos: string[];
}

/// Erros e avisos de UMA linha, sejam quais forem os nomes que a Meta usa
/// para escrever a mensagem dentro de cada item.
function lerAviso(item: unknown): AvisoDoCatalogo {
  const linha = objectInput(item);
  const textos = (valor: unknown) => (Array.isArray(valor) ? valor : [])
    .map((e) => {
      if (typeof e === "string") return e;
      const obj = objectInput(e);
      const msg = [obj.message, obj.description, obj.title]
        .find((m) => typeof m === "string" && m);
      return typeof msg === "string" ? msg : JSON.stringify(e);
    })
    .filter(Boolean)
    .slice(0, 10);
  return {
    retailerId: typeof linha.retailer_id === "string" ? linha.retailer_id
      : typeof linha.retailer_id === "number" ? String(linha.retailer_id) : null,
    erros: textos(linha.errors),
    avisos: textos(linha.warnings),
  };
}

function lerValidacao(corpo: Record<string, unknown>): AvisoDoCatalogo[] {
  const lista = Array.isArray(corpo.validation_status) ? corpo.validation_status : [];
  return lista.map(lerAviso);
}

export interface ResultadoDoLote {
  /// O identificador da gravação, para consultar o destino depois. Vazio
  /// quando a Meta não ingeriu nada -- e isso é falha, não sucesso silencioso.
  handle: string;
  validacao: AvisoDoCatalogo[];
}

/**
 * Envia itens para o catálogo.
 *
 * `UPDATE` com `allow_upsert` cria E edita: reenviar o mesmo `id` (o SKU) com
 * preço novo é edição, não item novo. `CREATE` recusaria o que já existe, e o
 * modelo desta plataforma é de estado desejado -- a rodada reenvia o valor
 * atual sem saber se o item já está lá.
 */
export async function enviarItensFacebook(
  cfg: Record<string, string>, token: string, requisicoes: unknown[],
  fetcher: typeof fetch = fetch,
): Promise<ResultadoDoLote> {
  const corpoJson = JSON.stringify(requisicoes);
  if (Buffer.byteLength(corpoJson, "utf8") > LIMITE_CORPO_BYTES) {
    throw new OrderError("O item passou do tamanho que a Meta aceita no catálogo.");
  }
  const parametros = new URLSearchParams({
    item_type: "PRODUCT_ITEM",
    requests: corpoJson,
    // Explícito, embora seja o padrão: é o que faz o UPDATE criar o que ainda
    // não existe, e um padrão que mude do lado deles quebraria a publicação.
    allow_upsert: "true",
  });

  const response = await fetcher(
    `${facebookGraphBase(cfg)}/${facebookCatalogId(cfg)}/items_batch`,
    {
      method: "POST",
      headers: {
        // O token vai no cabeçalho, e não na query: query aparece em log de
        // servidor e de proxy, e este token escreve no catálogo.
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: parametros,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    },
  );

  const corpo = await lerResposta(response, "Falha ao enviar o item ao catálogo do Facebook");
  const handles = Array.isArray(corpo.handles) ? corpo.handles : [];
  const handle = typeof handles[0] === "string" ? handles[0] : "";
  return { handle, validacao: lerValidacao(corpo) };
}

export interface StatusDoLote {
  /// Palavra da Meta: `finished`, `in_progress`… Nula quando ela não diz.
  status: string | null;
  validacao: AvisoDoCatalogo[];
}

/**
 * O destino do lote, pelo `handle`.
 *
 * LIMITE DECLARADO: a documentação descreve a resposta como "validação de cada
 * item", sem fixar os nomes dos campos. A leitura aqui é tolerante de
 * propósito -- campo que faltar vira lista vazia, e não exceção -- porque uma
 * consulta de diagnóstico não pode derrubar uma publicação que já foi aceita.
 */
export async function consultarLoteFacebook(
  cfg: Record<string, string>, token: string, handle: string,
  fetcher: typeof fetch = fetch,
): Promise<StatusDoLote> {
  const url = new URL(
    `${facebookGraphBase(cfg)}/${facebookCatalogId(cfg)}/check_batch_request_status`);
  url.searchParams.set("handle", handle);
  const response = await fetcher(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });

  const corpo = await lerResposta(response, "Falha ao consultar o envio ao catálogo do Facebook");
  // A Meta devolve uma coleção; o lote é um só, então é a primeira linha.
  const dados = Array.isArray(corpo.data) ? corpo.data : [];
  const primeiro = objectInput(dados[0] ?? corpo);
  return {
    status: typeof primeiro.status === "string" ? primeiro.status : null,
    // Aqui a Meta relata por linha do lote: os erros e avisos estão NA linha,
    // e não num `validation_status` dentro dela como na resposta do envio.
    // Aceitamos as duas formas porque a documentação descreve o conteúdo e não
    // o formato -- e uma consulta de diagnóstico não pode depender de palpite.
    validacao: Array.isArray(primeiro.validation_status)
      ? lerValidacao(primeiro)
      : [lerAviso(primeiro)],
  };
}
