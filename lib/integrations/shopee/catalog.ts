import "server-only";
import { createHash } from "node:crypto";
import { objectInput, OrderError, textInput } from "../../domain/order-input";
import { ListingWithProduct, PartialPublishError, PublishResult } from "../../services/listings";
import {
  agoraEmSegundos, assinarShopee, chamarShopee, lerRespostaShopee, shopeeConfig, ShopeeCredenciais,
} from "./client";

/**
 * Publicação de anúncio na Shopee.
 *
 * Quatro diferenças em relação ao Mercado Livre que mudam o desenho, todas
 * vindas da documentação (nada aqui foi medido contra a API real):
 *
 * 1. **Imagem só por upload.** A Shopee não busca imagem por URL: o anúncio
 *    referencia `image_id`, e o id só existe depois de subir o arquivo por
 *    `media_space/upload_image`. Então URL externa é RECUSADA por nós, com
 *    mensagem dizendo o que fazer — baixar a imagem da URL aqui dentro seria
 *    transformar o servidor em buscador de endereço arbitrário.
 * 2. **Preço e estoque têm rotas próprias.** Não existe "atualize o anúncio
 *    inteiro": são `update_price`, `update_stock` e `update_item`, cada uma com
 *    o seu corpo.
 * 3. **Logística é obrigatória na criação.** O anúncio precisa declarar por
 *    quais canais de entrega ele sai, e os canais são da LOJA, não nossos. São
 *    lidos da conta na hora de publicar.
 * 4. **Peso é obrigatório.** O nosso catálogo não tem peso — é dado de
 *    logística, não de produto. Vem de ambiente, com valor declarado, e nunca
 *    de um palpite por categoria.
 */

/// Teto de imagens por anúncio na Shopee.
const MAX_IMAGENS = 9;
/// Peso padrão, em quilos. É dado do anunciante: o catálogo não guarda peso, e
/// inventar por categoria seria pior que um valor único e visível.
const PESO_PADRAO_KG = "0.5";

const EXTENSAO_POR_TIPO: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * O que foi publicado além de preço e estoque.
 *
 * Guardado em `publishedAttributes` pelo trabalhador, o que dá ao adapter
 * memória entre rodadas. Serve a um propósito concreto: sem ele, toda
 * sincronização de estoque — e há uma por venda — teria de reenviar título,
 * descrição e o álbum inteiro, porque a impressão do anúncio é opaca e não diz
 * O QUE mudou. Com o resumo, a rodada comum é duas chamadas baratas.
 */
interface EstadoPublicado {
  conteudo: string;
  imagens: string[];
}

function lerEstadoPublicado(valor: unknown): EstadoPublicado | null {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return null;
  const dados = valor as Record<string, unknown>;
  if (typeof dados.conteudo !== "string" || !dados.conteudo) return null;
  return {
    conteudo: dados.conteudo,
    imagens: Array.isArray(dados.imagens) ? dados.imagens.filter((i): i is string => typeof i === "string") : [],
  };
}

/// Impressão do que viaja em `update_item`: título, descrição e álbum. Preço e
/// estoque ficam de fora porque eles têm rota própria e são sempre enviados.
export function impressaoDeConteudo(listing: ListingWithProduct) {
  const p = listing.product;
  return createHash("sha256")
    .update(JSON.stringify([p.title, p.description, p.images.map((i) => i.url)]))
    .digest("hex");
}

/**
 * Sobe uma imagem e devolve o id.
 *
 * Multipart assinado: a assinatura é a mesma das outras chamadas de loja (é
 * sobre o caminho, não sobre o corpo), mas o corpo não pode levar
 * `Content-Type` nosso — o limite do multipart é o `FormData` que define.
 */
async function subirImagem(
  cfg: Record<string, string>, loja: ShopeeCredenciais, dataUri: string, fetcher: typeof fetch,
): Promise<string> {
  const config = shopeeConfig(cfg);
  const separador = dataUri.indexOf(";base64,");
  if (!dataUri.startsWith("data:") || separador < 0) {
    throw new OrderError("Imagem em formato que a Shopee não aceita.");
  }
  const tipo = dataUri.slice(5, separador);
  const extensao = EXTENSAO_POR_TIPO[tipo];
  if (!extensao) {
    throw new OrderError(
      `A Shopee não aceita imagem ${tipo.replace("image/", "").toUpperCase()}. Use PNG, JPEG ou WEBP.`);
  }

  const caminho = "/api/v2/media_space/upload_image";
  const timestamp = agoraEmSegundos();
  const url = new URL(config.host + caminho);
  url.searchParams.set("partner_id", config.partnerId);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", assinarShopee(config, caminho, timestamp, loja));
  url.searchParams.set("access_token", loja.accessToken);
  url.searchParams.set("shop_id", loja.shopId);

  const binario = Buffer.from(dataUri.slice(separador + 8), "base64");
  const form = new FormData();
  // O nome leva a extensão pela mesma razão que no Mercado Livre: provedor que
  // decide formato pelo nome recusa arquivo sem extensão, e a mensagem dele
  // não diz que o problema é o nome.
  form.append("image", new Blob([new Uint8Array(binario)], { type: tipo }), `imagem.${extensao}`);

  const response = await fetcher(url.toString(), {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(60000),
  });
  const corpo = await lerRespostaShopee(response, "A Shopee recusou a imagem");
  const conteudo = objectInput(corpo.response ?? {});
  // A resposta traz `image_info` numa chamada de arquivo único e
  // `image_info_list` quando são vários. Aceitar as duas formas evita depender
  // de qual delas a conta recebe.
  const info = conteudo.image_info
    ? objectInput(conteudo.image_info)
    : objectInput((Array.isArray(conteudo.image_info_list) ? conteudo.image_info_list[0] : null) ?? {});
  return textInput(info.image_id, "Identificador da imagem", 200);
}

export async function prepararImagensShopee(
  cfg: Record<string, string>, loja: ShopeeCredenciais, urls: string[],
  fetcher: typeof fetch = fetch,
) {
  if (!urls.length) throw new OrderError("A Shopee exige ao menos uma imagem no anúncio.");
  const ids: string[] = [];
  for (const url of urls.slice(0, MAX_IMAGENS)) {
    if (!url.startsWith("data:")) {
      // Baixar a URL aqui faria o servidor buscar endereço arbitrário a pedido
      // de quem cadastra. A recusa é nossa, e diz o caminho.
      throw new OrderError(
        "A Shopee só aceita imagem enviada como arquivo, não por URL. Envie a imagem"
        + " do computador no álbum do produto.");
    }
    ids.push(await subirImagem(cfg, loja, url, fetcher));
  }
  return ids;
}

/**
 * Canais de entrega habilitados na loja.
 *
 * A criação exige declarar logística, e quais canais existem é decisão da
 * loja, tomada no Seller Center. Ler da conta é o único jeito de não chutar —
 * e loja sem canal habilitado precisa de mensagem que diga isso, porque o erro
 * do provedor fala de campo inválido.
 */
export async function logisticasHabilitadas(
  cfg: Record<string, string>, loja: ShopeeCredenciais, fetcher: typeof fetch = fetch,
) {
  const conteudo = await chamarShopee(cfg, "/api/v2/logistics/get_channel_list", {
    loja, oQueFalhou: "Falha ao ler os canais de entrega da Shopee",
  }, fetcher);
  const lista = Array.isArray(conteudo.logistics_channel_list) ? conteudo.logistics_channel_list : [];
  const habilitados = lista.map(objectInput)
    .filter((canal) => canal.enabled === true)
    .map((canal) => Number(canal.logistics_channel_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!habilitados.length) {
    throw new OrderError(
      "Nenhum canal de entrega está habilitado nesta loja da Shopee. Habilite a"
      + " logística no Seller Center antes de publicar.");
  }
  return habilitados.map((id) => ({ logistic_id: id, enabled: true }));
}

function pesoEmKg(cfg: Record<string, string>) {
  const bruto = (cfg.defaultWeightKg || PESO_PADRAO_KG).trim();
  const peso = Number(bruto);
  if (!Number.isFinite(peso) || peso <= 0) {
    throw new OrderError("Peso padrão (kg) inválido na configuração do canal.");
  }
  return peso;
}

function categoriaDe(listing: ListingWithProduct) {
  const categoria = listing.categoryExternalId ?? "";
  if (!/^\d{1,20}$/.test(categoria)) {
    throw new OrderError("Escolha a categoria da Shopee antes de publicar, na aba Categoria.");
  }
  return Number(categoria);
}

/// A Shopee só conhece novo e usado.
export function condicaoShopee(condicao: string) {
  return /usado|seminovo|semi-novo/.test(condicao.trim().toLowerCase()) ? "USED" : "NEW";
}

export async function publishShopeeListing(
  cfg: Record<string, string>, loja: ShopeeCredenciais, listing: ListingWithProduct,
  fetcher: typeof fetch = fetch,
): Promise<PublishResult> {
  const produto = listing.product;
  const preco = Number(produto.price.toFixed(2));
  const conteudo = impressaoDeConteudo(listing);

  if (!listing.externalListingId) {
    const [imagens, logistica] = await Promise.all([
      prepararImagensShopee(cfg, loja, produto.images.map((i) => i.url), fetcher),
      logisticasHabilitadas(cfg, loja, fetcher),
    ]);
    const resposta = await chamarShopee(cfg, "/api/v2/product/add_item", {
      metodo: "POST",
      loja,
      corpo: {
        item_name: produto.title,
        description: produto.description,
        category_id: categoriaDe(listing),
        original_price: preco,
        // Estoque do vendedor, que é a forma atual; `normal_stock` é a antiga.
        seller_stock: [{ stock: produto.stock }],
        item_status: produto.active ? "NORMAL" : "UNLIST",
        condition: condicaoShopee(produto.condition),
        weight: pesoEmKg(cfg),
        image: { image_id_list: imagens },
        logistic_info: logistica,
      },
      oQueFalhou: "A Shopee recusou o anúncio",
      timeoutMs: 60000,
    }, fetcher);

    const itemId = resposta.item_id;
    if (typeof itemId !== "number" && typeof itemId !== "string") {
      throw new OrderError("Publicação na Shopee sem identificador.");
    }
    return {
      externalListingId: String(itemId),
      // A Shopee não devolve preço e estoque confirmados na criação: o que
      // registramos é o que foi enviado, e a diferença é declarada aqui em vez
      // de virar um número inventado.
      price: produto.price.toFixed(2),
      stock: produto.stock,
      externalStatus: typeof resposta.item_status === "string" ? resposta.item_status : null,
      sentAttributes: { conteudo, imagens } satisfies EstadoPublicado,
    };
  }

  const itemId = Number(listing.externalListingId);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new OrderError("Identificador de anúncio da Shopee inválido.");
  }

  // Preço e estoque vão sempre: são o que muda a cada venda, e são baratos.
  await chamarShopee(cfg, "/api/v2/product/update_price", {
    metodo: "POST", loja,
    corpo: { item_id: itemId, price_list: [{ original_price: preco }] },
    oQueFalhou: "A Shopee recusou a atualização de preço",
  }, fetcher);
  await chamarShopee(cfg, "/api/v2/product/update_stock", {
    metodo: "POST", loja,
    corpo: { item_id: itemId, stock_list: [{ seller_stock: [{ stock: produto.stock }] }] },
    oQueFalhou: "A Shopee recusou a atualização de estoque",
  }, fetcher);

  const publicado = lerEstadoPublicado(listing.publishedAttributes);
  // Nada de conteúdo mudou: não se reenvia título, descrição nem o álbum. Sem
  // esta comparação, cada venda recarregaria todas as imagens do produto.
  if (publicado && publicado.conteudo === conteudo) {
    return {
      externalListingId: listing.externalListingId,
      price: produto.price.toFixed(2),
      stock: produto.stock,
      externalStatus: null,
      // Preserva o resumo anterior: devolver undefined aqui apagaria a memória
      // que evita o reenvio das imagens na próxima rodada.
      sentAttributes: publicado,
    };
  }

  // Conteúdo mudou. As imagens sobem de novo porque o id que a Shopee devolve
  // é do arquivo enviado, e não há como referenciar o que já está lá sem
  // guardá-lo -- que é exatamente o que o resumo faz, mas só vale enquanto o
  // álbum não muda.
  const imagens = await prepararImagensShopee(cfg, loja, produto.images.map((i) => i.url), fetcher);
  try {
    const resposta = await chamarShopee(cfg, "/api/v2/product/update_item", {
      metodo: "POST", loja,
      corpo: {
        item_id: itemId,
        item_name: produto.title,
        description: produto.description,
        item_status: produto.active ? "NORMAL" : "UNLIST",
        image: { image_id_list: imagens },
      },
      oQueFalhou: "A Shopee recusou a atualização do anúncio",
      timeoutMs: 60000,
    }, fetcher);
    return {
      externalListingId: listing.externalListingId,
      price: produto.price.toFixed(2),
      stock: produto.stock,
      externalStatus: typeof resposta.item_status === "string" ? resposta.item_status : null,
      sentAttributes: { conteudo, imagens } satisfies EstadoPublicado,
    };
  } catch (erro) {
    // Preço e estoque já foram aceitos. Deixar o erro subir puro perderia o
    // registro deles e a próxima rodada faria tudo de novo -- inclusive as
    // imagens, que acabaram de subir.
    throw new PartialPublishError({
      externalListingId: listing.externalListingId,
      price: produto.price.toFixed(2),
      stock: produto.stock,
      externalStatus: null,
    }, erro);
  }
}
