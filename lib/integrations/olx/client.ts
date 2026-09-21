import "server-only";
import { objectInput, OrderError, textInput } from "../../domain/order-input";
import { ProviderAuthError, ProviderTransientError } from "../mercadolivre/client";

/**
 * Cliente da API de anúncios da OLX (autoupload).
 *
 * Duas coisas separam a OLX dos outros provedores deste sistema, e as duas
 * mudam o desenho:
 *
 * 1. **Não existe pedido.** A OLX é classificados: o anúncio publica, o
 *    comprador liga ou chama no chat, e a venda acontece fora da plataforma.
 *    Então este provedor participa só da jornada de SAÍDA. A de entrada
 *    (aviso -> venda -> baixa de estoque) não existe aqui, e é melhor dizer
 *    isso com uma mensagem clara do que fingir que vai funcionar.
 * 2. **A importação é assíncrona.** O `PUT` valida a forma e devolve um token;
 *    o destino de cada anúncio -- aceito, recusado, com qual erro -- só sai
 *    numa segunda chamada, sobre esse token.
 *
 * O contrato aqui é documentação pública verificada (developers.olx.com.br),
 * mas nada foi exercitado: a credencial de integrador sai por aprovação manual
 * por e-mail e exige plano empresarial.
 */

const BASE_PADRAO = "https://apps.olx.com.br";
/// Teto de corpo da requisição declarado pela OLX.
const LIMITE_CORPO_BYTES = 1024 * 1024;

export class OlxConfigurationError extends Error {}

/// Base do autoupload, vinda do cadastro do canal (era `OLX_API_URL`).
export function olxApiBase(cfg: Record<string, string>) {
  const bruto = (cfg.apiUrl || BASE_PADRAO).replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(bruto); } catch { throw new OlxConfigurationError("URL da API da OLX inválida."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new OlxConfigurationError("URL da API da OLX inválida.");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/**
 * Dados do ANUNCIANTE que o anúncio exige e o catálogo não tem.
 *
 * Telefone e CEP são do vendedor, não do produto: repeti-los em cada produto
 * seria copiar o mesmo valor mil vezes e deixar mil lugares para errar.
 *
 * Vêm do cadastro da ORGANIZAÇÃO, e não do ambiente. A diferença importa num
 * sistema em que o mesmo deploy atende vários tenants: uma variável de
 * ambiente serviria a todos ao mesmo tempo, e o anúncio de um sairia com o
 * telefone do outro.
 */
export interface AnuncianteOlx {
  telefone: string;
  cep: string;
}

/**
 * Códigos que a OLX devolve na validação síncrona.
 *
 * A tradução importa porque decide o que o trabalhador faz: bloqueio por
 * excesso de requisições e serviço indisponível pedem nova tentativa; falta de
 * permissão, de slot ou anúncio inválido pedem intervenção, e insistir neles
 * só queima as oito tentativas do anúncio.
 */
const MENSAGEM_POR_CODIGO: Record<number, string> = {
  [-1]: "A OLX relatou um erro inesperado na importação.",
  [-3]: "A OLX não recebeu nenhum anúncio para importar.",
  [-4]: "A OLX recusou o anúncio na validação e cancelou a importação.",
  [-6]: "A conta não tem permissão para importar anúncios. Verifique o plano contratado na OLX.",
  [-7]: "O plano da conta não tem vagas suficientes para publicar este anúncio.",
  [-8]: "A importação foi parcial: algum anúncio passou dos limites do plano.",
};
const CODIGOS_TEMPORARIOS = new Set([-2, -5]);

export interface OlxImportResult {
  /// Token da importação, para consultar o destino de cada anúncio depois.
  token: string;
}

async function lerResposta(response: Response, oQueFalhou: string) {
  if (response.status === 401 || response.status === 403) throw new ProviderAuthError("OLX_UNAUTHORIZED");
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("OLX_UNAVAILABLE");
  if (response.status === 413) {
    throw new OrderError("O anúncio passou do tamanho que a OLX aceita (1 MB).");
  }
  if (!response.ok) throw new OrderError(`${oQueFalhou}.`);
  return objectInput(await response.json().catch(() => null));
}

/// Traduz o `statusCode` da OLX. Zero é sucesso; negativo é falha, e a classe
/// da falha decide se vale tentar de novo.
function conferirStatusCode(corpo: Record<string, unknown>, oQueFalhou: string) {
  const codigo = typeof corpo.statusCode === "number" ? corpo.statusCode : null;
  if (codigo === null) throw new OrderError(`${oQueFalhou}: resposta sem statusCode.`);
  if (codigo === 0) return;
  if (CODIGOS_TEMPORARIOS.has(codigo)) throw new ProviderTransientError("OLX_UNAVAILABLE");

  // A mensagem do provedor ajuda quem cadastrou -- é o que diz qual campo do
  // anúncio está errado -- e não carrega credencial.
  const detalhe = typeof corpo.statusMessage === "string" && corpo.statusMessage
    ? corpo.statusMessage : "";
  const erros = Array.isArray(corpo.errors)
    ? corpo.errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join(" | ")
    : "";
  const base = MENSAGEM_POR_CODIGO[codigo] ?? `${oQueFalhou} (statusCode ${codigo}).`;
  const cauda = [detalhe, erros].filter(Boolean).join(" | ").slice(0, 300);
  throw new OrderError(cauda ? `${base} ${cauda}` : base);
}

/**
 * Envia a lista de anúncios.
 *
 * `insert` cria E edita: a OLX casa pelo `id` que NÓS mandamos, então reenviar
 * o mesmo anúncio com outro preço é edição, não duplicação. É o que faz o
 * modelo de estado desejado funcionar aqui.
 */
export async function importarAnunciosOlx(
  cfg: Record<string, string>, token: string, anuncios: unknown[],
  fetcher: typeof fetch = fetch,
): Promise<OlxImportResult> {
  if (!anuncios.length) throw new OrderError("Nenhum anúncio para enviar à OLX.");
  const corpo = JSON.stringify({ access_token: token, ad_list: anuncios });
  // Conferido aqui, e não pelo 413: a mensagem do provedor não diz o tamanho, e
  // sem o número ninguém sabe o quanto precisa cortar.
  const bytes = Buffer.byteLength(corpo, "utf8");
  if (bytes > LIMITE_CORPO_BYTES) {
    throw new OrderError(
      `O anúncio ficou com ${Math.round(bytes / 1024)} KB e a OLX aceita até 1024 KB.`
      + " Use imagens por URL, e não arquivos embutidos.");
  }

  const response = await fetcher(`${olxApiBase(cfg)}/autoupload/import`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: corpo,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  const resposta = await lerResposta(response, "Falha ao enviar o anúncio à OLX");
  conferirStatusCode(resposta, "A OLX recusou o anúncio");
  return { token: textInput(resposta.token, "Token da importação", 200) };
}

export interface OlxAdStatus {
  /// pending, queued, accepted, refused ou error, como o provedor reporta.
  status: string;
  /// Identificador do anúncio publicado. Só existe quando ele foi aceito.
  listId: string | null;
  url: string | null;
  mensagens: string[];
}

/**
 * Destino de cada anúncio de uma importação.
 *
 * É POST, e não GET, embora seja consulta: o token vai no caminho e a
 * credencial no corpo. Quem decidiu isso foi a OLX.
 */
export async function consultarImportacaoOlx(
  cfg: Record<string, string>, token: string, importacao: string, fetcher: typeof fetch = fetch,
) {
  const id = textInput(importacao, "Token da importação", 200);
  if (!/^[A-Za-z0-9._~-]+$/.test(id)) throw new OrderError("Token da importação inválido.");

  const response = await fetcher(`${olxApiBase(cfg)}/autoupload/import/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ access_token: token }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  const corpo = await lerResposta(response, "Falha ao consultar a importação na OLX");

  const geral = typeof corpo.autoupload_status === "string" ? corpo.autoupload_status : "pending";
  const anuncios: OlxAdStatus[] = (Array.isArray(corpo.ads) ? corpo.ads : []).map((cru) => {
    const linha = objectInput(cru);
    return {
      status: typeof linha.status === "string" ? linha.status : "pending",
      listId: linha.list_id === undefined || linha.list_id === null ? null : String(linha.list_id),
      url: typeof linha.url === "string" && linha.url ? linha.url : null,
      // As mensagens são o valor da consulta: é onde vem ERROR_IMAGE_TOO_SMALL
      // ou REFUSED_SUSPECT_CATEGORY, que é o que explica a recusa.
      mensagens: (Array.isArray(linha.message) ? linha.message : [])
        .map((m) => (typeof m === "string" ? m : JSON.stringify(m))).slice(0, 10),
    };
  });
  return { geral, anuncios };
}
