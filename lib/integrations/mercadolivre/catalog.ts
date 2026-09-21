import "server-only";
import { objectInput, OrderError, textInput } from "../../domain/order-input";
import { lerAtributos } from "../../services/listing-attributes";
import { ListingWithProduct, PublishResult } from "../../services/listings";
import { API_ORIGIN, ProviderAuthError, ProviderTransientError } from "./client";

/**
 * Publicação de anúncio no Mercado Livre.
 *
 * Cada regra aqui foi descoberta na prática contra a API real, porque o portal
 * de desenvolvedores responde 403 a consulta automatizada. O que a resposta de
 * erro do provedor ensinou, em ordem:
 *
 * 1. O MLB publica por família: manda-se `family_name`, e o `title` passa a ser
 *    RECUSADO — o título é derivado dos atributos pelo próprio provedor.
 * 2. Cada categoria exige atributos próprios. Os que não soubermos preencher
 *    viram erro nomeado, e não um anúncio pela metade lá dentro.
 * 3. GTIN é condicionalmente obrigatório. Mandar texto qualquer dá formato
 *    inválido; omitir dá campo faltando. O que funciona é mandar GTIN com
 *    valor nulo JUNTO de EMPTY_GTIN_REASON — o provedor derruba o vazio com um
 *    aviso e aceita.
 * 4. Imagem por URL externa o provedor busca sozinho; data URI ele não busca,
 *    então o arquivo é enviado antes por `/pictures/items/upload` e o anúncio
 *    referencia o id devolvido.
 * 5. ME2 é obrigatório para a conta de teste, o que bloqueia a publicação.
 *    Retirada em mãos contorna, e a tag `adoption_required` que sobra é aviso.
 */

/// O tipo de anúncio decide exposição e tarifa. Clássico é o que não exige
/// contrato adicional; premium custaria mais sem escolha de quem publica.
const TIPO_DE_ANUNCIO = "gold_special";
/// Teto do provedor por anúncio. O álbum já para em 10, mas o teto é dele.
const MAX_FOTOS = 12;

/**
 * Extensão por tipo, para o nome do arquivo enviado.
 *
 * O provedor decide o formato pela EXTENSÃO DO NOME, não pelo content-type.
 * Medido: o mesmo PNG sobe como "imagem.png" e é recusado como "imagem", com
 * "The file type is not supported". E sobe como "foto.jpg" também, o que
 * confirma que ele nem olha o conteúdo.
 *
 * AVIF fica de fora porque o provedor não o aceita -- o álbum aceita, e é por
 * isso que a recusa precisa ser nossa, nomeando o formato.
 */
const EXTENSAO_POR_TIPO: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

interface Atributo {
  id: string;
  value_id?: string;
  value_name?: string | null;
}

function cabecalhos(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function tratar(response: Response, oQueFalhou: string) {
  if (response.status === 401 || response.status === 403) throw new ProviderAuthError("ML_UNAUTHORIZED");
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("ML_UNAVAILABLE");
  if (!response.ok) {
    // A causa do provedor é informação de domínio e ajuda quem cadastrou: é o
    // que diz QUAL atributo falta. Não carrega credencial, mas vem cortada.
    const texto = await response.text();
    let motivo = "";
    try {
      const corpo = objectInput(JSON.parse(texto));
      const causas = Array.isArray(corpo.cause) ? corpo.cause.map(objectInput) : [];
      motivo = causas.map((c) => String(c.message ?? c.code ?? "")).filter(Boolean).join(" | ")
        || String(corpo.message ?? "");
    } catch { motivo = ""; }
    throw new OrderError(`${oQueFalhou}${motivo ? ": " + motivo.slice(0, 300) : "."}`);
  }
  return objectInput(await response.json());
}

/**
 * Atributos exigidos pela categoria, preenchidos com o que o catálogo sabe.
 *
 * O que não dá para preencher não é chutado: vira erro nomeando os atributos
 * que faltam. Um valor inventado publicaria um anúncio errado, que é pior que
 * não publicar.
 */
export async function montarAtributos(
  token: string, categoryId: string, listing: ListingWithProduct, fetcher: typeof fetch = fetch,
): Promise<Atributo[]> {
  const response = await fetcher(`${API_ORIGIN}/categories/${categoryId}/attributes`, {
    method: "GET", headers: cabecalhos(token), redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const corpo = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) throw new ProviderAuthError("ML_UNAUTHORIZED");
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("ML_UNAVAILABLE");
  if (!response.ok || !Array.isArray(corpo)) {
    throw new OrderError("Não foi possível ler os atributos da categoria no Mercado Livre.");
  }

  const produto = listing.product;
  // O que quem cadastra preencheu vence o automático: a tela mostra o valor
  // derivado como sugestão justamente para poder ser sobreposto.
  const preenchidos = lerAtributos(listing.attributes);
  const atributos: Atributo[] = [];
  const naoPreenchidos: string[] = [];
  let temGtin = false;

  for (const cru of corpo) {
    const atributo = objectInput(cru);
    const id = textInput(atributo.id, "Atributo", 60);
    const tags = atributo.tags ? objectInput(atributo.tags) : {};
    if (!tags.required && !tags.conditional_required) continue;

    const preenchido = preenchidos[id];
    if (preenchido) {
      atributos.push(preenchido.valueId
        ? { id, value_id: preenchido.valueId }
        : { id, value_name: preenchido.valueName });
      if (id === "GTIN") temGtin = true;
      continue;
    }

    if (id === "GTIN") {
      // Sem código informado, declara-se o vazio. Em categoria onde GTIN é
      // `required` de verdade -- livros, medido -- o provedor recusa mesmo
      // assim, e a mensagem dele diz isso.
      atributos.push({ id: "GTIN", value_name: null });
      continue;
    }
    if (id === "EMPTY_GTIN_REASON") {
      // Só faz sentido quando não há GTIN: mandar o motivo junto de um código
      // válido é contradição.
      if (temGtin) continue;
      const valores = Array.isArray(atributo.values) ? atributo.values.map(objectInput) : [];
      const semCodigo = valores.find((v) => /n[ãa]o tem c[óo]digo|sem c[óo]digo/i.test(String(v.name ?? "")))
        ?? valores[0];
      if (!semCodigo) { naoPreenchidos.push(id); continue; }
      atributos.push({ id, value_id: textInput(semCodigo.id, "Motivo de GTIN vazio", 60) });
      continue;
    }
    if (id === "BRAND") {
      if (!produto.brand) { naoPreenchidos.push("BRAND (marca do produto)"); continue; }
      atributos.push({ id, value_name: produto.brand });
      continue;
    }
    if (id === "MODEL") {
      // O SKU é curto, estável e único: serve de modelo melhor que o título,
      // que o provedor já usa para montar o nome do anúncio.
      atributos.push({ id, value_name: produto.sku });
      continue;
    }
    // Só o que a categoria exige DE VERDADE trava a publicação. Condicional
    // que não sabemos preencher fica de fora e o provedor decide.
    if (tags.required) {
      const nome = typeof atributo.name === "string" && atributo.name ? `${id} (${atributo.name})` : id;
      naoPreenchidos.push(nome);
    }
  }

  if (naoPreenchidos.length) {
    throw new OrderError(
      "A categoria escolhida exige atributos que ainda não foram preenchidos: "
      + naoPreenchidos.join(", ") + ". Preencha-os na aba Categoria ou escolha outra categoria.");
  }
  return atributos;
}

/**
 * Deixa as imagens em forma que o provedor aceite.
 *
 * URL externa ele busca sozinho. Data URI não — o arquivo precisa subir antes,
 * e o anúncio referencia o id devolvido.
 */
export async function prepararFotos(
  token: string, urls: string[], fetcher: typeof fetch = fetch,
): Promise<{ id?: string; source?: string }[]> {
  const fotos: { id?: string; source?: string }[] = [];
  for (const url of urls.slice(0, MAX_FOTOS)) {
    if (!url.startsWith("data:")) { fotos.push({ source: url }); continue; }

    const separador = url.indexOf(";base64,");
    const tipo = url.slice(5, separador);
    const extensao = EXTENSAO_POR_TIPO[tipo];
    if (!extensao) {
      throw new OrderError(
        `O Mercado Livre não aceita imagem ${tipo.replace("image/", "").toUpperCase()}. `
        + "Use PNG, JPEG, WEBP ou GIF.");
    }
    const binario = Buffer.from(url.slice(separador + 8), "base64");
    const form = new FormData();
    // O nome precisa carregar a extensão: é por ela que o provedor decide o
    // formato, e sem ela a resposta é "file type is not supported".
    form.append("file", new Blob([new Uint8Array(binario)], { type: tipo }), `imagem.${extensao}`);

    const response = await fetcher(`${API_ORIGIN}/pictures/items/upload`, {
      method: "POST",
      // Sem Content-Type: o limite do multipart é o FormData que define.
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      body: form,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(60000),
    });
    const corpo = await tratar(response, "O Mercado Livre recusou a imagem");
    fotos.push({ id: textInput(corpo.id, "Identificador da imagem", 200) });
  }
  return fotos;
}

/**
 * Cria ou atualiza o anúncio.
 *
 * A categoria só vai na criação: o provedor restringe trocá-la depois, e
 * mandá-la numa atualização faria o anúncio inteiro ser recusado por causa de
 * um campo que nem mudou.
 */
export async function publishMercadoLivreListing(
  token: string, listing: ListingWithProduct, fetcher: typeof fetch = fetch,
): Promise<PublishResult> {
  const produto = listing.product;
  const categoria = listing.categoryExternalId;
  if (!categoria) {
    throw new OrderError("Escolha a categoria do Mercado Livre antes de publicar, na aba Categoria.");
  }
  if (!produto.images.length) {
    // O provedor recusa anúncio sem foto, e a mensagem dele não diz isso.
    throw new OrderError("O Mercado Livre exige ao menos uma imagem no anúncio.");
  }

  const preco = Number(produto.price.toFixed(2));
  if (listing.externalListingId) {
    const corpo = await tratar(await fetcher(`${API_ORIGIN}/items/${listing.externalListingId}`, {
      method: "PUT",
      headers: cabecalhos(token),
      body: JSON.stringify({ price: preco, available_quantity: produto.stock }),
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30000),
    }), "O Mercado Livre recusou a atualização do anúncio");
    return lerResultado(corpo, listing.externalListingId);
  }

  const [atributos, pictures] = await Promise.all([
    montarAtributos(token, categoria, listing, fetcher),
    prepararFotos(token, produto.images.map((i) => i.url), fetcher),
  ]);

  const corpo = await tratar(await fetcher(`${API_ORIGIN}/items`, {
    method: "POST",
    headers: cabecalhos(token),
    body: JSON.stringify({
      // `title` é recusado quando há family_name: o provedor monta o nome do
      // anúncio a partir dos atributos.
      family_name: produto.title,
      category_id: categoria,
      price: preco,
      currency_id: produto.currency,
      available_quantity: produto.stock,
      buying_mode: "buy_it_now",
      condition: condicaoDoProduto(produto.condition),
      listing_type_id: TIPO_DE_ANUNCIO,
      attributes: atributos,
      pictures,
      // Retirada em mãos contorna a exigência de ME2, que bloquearia a
      // publicação de conta sem logística contratada.
      shipping: { mode: "not_specified", local_pick_up: true, free_shipping: false },
    }),
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60000),
  }), "O Mercado Livre recusou o anúncio");

  // Só na criação: a atualização manda preço e estoque, e devolver lista
  // vazia aqui apagaria o registro do que foi enviado antes.
  return { ...lerResultado(corpo, null), sentAttributes: atributos };
}

/// O provedor só conhece três condições; o catálogo aceita texto livre.
export function condicaoDoProduto(condicao: string) {
  const normal = condicao.trim().toLowerCase();
  if (/usado|seminovo|semi-novo/.test(normal)) return "used";
  if (!normal) return "not_specified";
  return "new";
}

function lerResultado(corpo: Record<string, unknown>, idAnterior: string | null): PublishResult {
  const id = corpo.id ?? idAnterior;
  if (typeof id !== "string" && typeof id !== "number") {
    throw new OrderError("Publicação no Mercado Livre sem identificador.");
  }
  // O que o provedor confirmou, não o que pedimos: ele pode ajustar estoque.
  if (typeof corpo.price !== "number" || typeof corpo.available_quantity !== "number") {
    throw new OrderError("Publicação no Mercado Livre sem preço ou estoque.");
  }
  return {
    externalListingId: String(id),
    price: corpo.price.toFixed(2),
    stock: corpo.available_quantity,
    // O provedor aceita a criação e ainda assim pode devolver `under_review`:
    // aceito não é o mesmo que no ar.
    externalStatus: typeof corpo.status === "string" ? corpo.status : null,
  };
}
