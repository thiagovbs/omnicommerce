import "server-only";
import { OrderError } from "../../domain/order-input";
import { ListingWithProduct, PublishResult } from "../../services/listings";
import {
  AvisoDoCatalogo, consultarLoteFacebook, enviarItensFacebook, facebookCatalogId,
} from "./client";

/**
 * Publicação de produto no catálogo do Meta.
 *
 * Cinco decisões que valem registro, porque cada uma nasce de uma diferença
 * real entre o catálogo da Meta e os marketplaces deste sistema:
 *
 * 1. **O identificador do item é o SKU.** A Meta casa o item pelo `id` que
 *    mandamos (o `retailer_id`), e o SKU é o que o catálogo do cliente já usa
 *    -- inclusive num catálogo que ele alimente por outra fonte. Um id nosso
 *    duplicaria cada produto lá dentro. Em troca, corrigir um SKU aqui deixa o
 *    item antigo órfão no catálogo, e é preciso removê-lo por lá.
 * 2. **`UPDATE`, nunca `CREATE`.** Com `allow_upsert`, o `UPDATE` cria o que
 *    não existe e edita o que existe. É o que o modelo de estado desejado
 *    pede: a rodada reenvia o valor atual sem saber se o item já está lá.
 * 3. **Imagem só por URL.** A Meta busca a imagem no endereço informado; não
 *    há upload. Então imagem embutida (`data:`) é recusada por nós, com
 *    mensagem dizendo o que fazer -- a recusa dela viria como item inválido.
 * 4. **Produto desativado vira `DELETE`.** É como se despublica por aqui, e
 *    `active` entra na impressão do anúncio: desativar no catálogo derruba o
 *    item na rodada seguinte.
 * 5. **O link é obrigatório e não existe no produto.** A Meta recusa item sem
 *    página de destino, e o catálogo desta plataforma não guarda a URL da
 *    loja. Ela vem da configuração do canal (`productUrlBase`) e o SKU é
 *    acrescentado -- a mesma ideia do telefone e do CEP da OLX, que são do
 *    anunciante e não do produto.
 *
 * O que este canal NÃO é: anúncio no Marketplace. Não existe API pública para
 * isso (ver o cabeçalho de `client.ts`). O item publicado aqui abastece a loja
 * do Facebook e do Instagram, e chega ao Marketplace só para quem está no
 * programa de parceiros da Meta.
 */

/// A Meta aceita até 20 imagens adicionais além da principal; ficamos no que
/// ela documenta para o campo `image`.
const MAX_IMAGENS = 20;

/// Nomes que a Meta aceita em `condition`. O catálogo daqui guarda texto
/// livre, porque cada canal nomeia do seu jeito.
const CONDICAO: Record<string, "new" | "used" | "refurbished"> = {
  novo: "new", new: "new", "0km": "new",
  usado: "used", used: "used", seminovo: "used", "semi-novo": "used",
  recondicionado: "refurbished", refurbished: "refurbished", remanufaturado: "refurbished",
};

/// O `retailer_id`: o SKU do produto. Ver o ponto 1 do cabeçalho.
export function idDoItemFacebook(listing: ListingWithProduct) {
  const sku = listing.product.sku.trim();
  if (!sku) throw new OrderError("O produto precisa de SKU para ser publicado no Facebook.");
  // Teto declarado pela Meta para o identificador do item.
  if (sku.length > 100) {
    throw new OrderError("O SKU passa de 100 caracteres, que é o limite do catálogo da Meta.");
  }
  return sku;
}

function condicaoDe(listing: ListingWithProduct) {
  const bruta = listing.product.condition.trim().toLowerCase();
  // Sem condição cadastrada o item é novo: é o que a loja vende por padrão, e
  // recusar aqui travaria a publicação de todo catálogo que não preenche o
  // campo. Quem vende usado preenche, e a tradução acima cobre as palavras.
  if (!bruta) return "new";
  const traduzida = CONDICAO[bruta];
  if (!traduzida) {
    throw new OrderError(
      `A Meta aceita apenas novo, usado ou recondicionado; o produto está como "${listing.product.condition}".`);
  }
  return traduzida;
}

function imagensDe(listing: ListingWithProduct) {
  const urls = listing.product.images.map((i) => i.url);
  if (!urls.length) throw new OrderError("A Meta exige ao menos uma imagem no item do catálogo.");
  if (urls.some((url) => url.startsWith("data:"))) {
    throw new OrderError(
      "A Meta busca a imagem pelo endereço e não aceita arquivo embutido. Cadastre a"
      + " imagem do produto por URL pública para publicar neste canal.");
  }
  const invalida = urls.find((url) => !/^https:\/\//.test(url));
  if (invalida) {
    // A Meta busca a imagem do servidor dela: endereço http simples costuma
    // ser recusado, e o motivo chegaria como item inválido, sem nomear a imagem.
    throw new OrderError("A Meta exige imagem em HTTPS.");
  }
  return urls.slice(0, MAX_IMAGENS).map((url) => ({ url }));
}

/// A página do produto, montada com a base do canal. Ver o ponto 5.
function linkDe(cfg: Record<string, string>, sku: string) {
  const base = (cfg.productUrlBase || "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new OrderError(
      "Informe o endereço base do produto na configuração do canal: a Meta exige"
      + " um link de destino em cada item.");
  }
  return `${base}/${encodeURIComponent(sku)}`;
}

/// Monta o item. Separado da chamada para ter teste sobre a forma exata do
/// corpo -- que é onde o contrato da Meta é mais exigente.
export function facebookItemPayload(cfg: Record<string, string>, listing: ListingWithProduct) {
  const produto = listing.product;
  const id = idDoItemFacebook(listing);

  // Produto desativado sai do catálogo. O `DELETE` leva só o id: mandar o
  // resto seria descrever um item que está sendo removido.
  if (!produto.active) return { method: "DELETE", data: { id } };

  if (!produto.title.trim()) throw new OrderError("O item do catálogo precisa de título.");
  if (!produto.description.trim()) {
    // A Meta exige descrição; recusar aqui nomeia o campo, enquanto a recusa
    // dela viria como validação genérica do item.
    throw new OrderError("A Meta exige descrição no item. Preencha a descrição do produto.");
  }
  if (!produto.brand.trim()) {
    throw new OrderError("A Meta exige marca no item. Preencha a marca do produto.");
  }

  const preco = Number(produto.price);
  if (!Number.isFinite(preco) || preco <= 0) {
    throw new OrderError("A Meta exige preço maior que zero no item do catálogo.");
  }

  return {
    method: "UPDATE",
    data: {
      id,
      title: produto.title.trim().slice(0, 100),
      description: produto.description.trim().slice(0, 5000),
      // "9.99 BRL": valor, espaço e o código ISO de três letras. A moeda é a
      // do produto, e não uma constante: o catálogo aceita mais de uma.
      price: `${preco.toFixed(2)} ${produto.currency}`,
      // Estoque zero não apaga o item: ele fica no catálogo marcado como
      // esgotado, que é o que preserva histórico, avaliações e anúncios.
      availability: produto.stock > 0 ? "in stock" : "out of stock",
      quantity_to_sell_on_facebook: produto.stock,
      condition: condicaoDe(listing),
      brand: produto.brand.trim(),
      link: linkDe(cfg, id),
      image: imagensDe(listing),
    },
  };
}

/// O que ficou registrado do envio, para a tela mostrar o item publicado.
/// Vai em `publishedAttributes`.
interface EstadoFacebook {
  catalogo: string;
  handle: string;
  status: string | null;
  mensagens: string[];
}

function mensagensDe(validacao: AvisoDoCatalogo[], id: string) {
  // A Meta responde por `retailer_id`; quando ela não o repete, o lote é de um
  // item só e o aviso é dele.
  const minhas = validacao.filter((v) => v.retailerId === null || v.retailerId === id);
  return {
    erros: minhas.flatMap((v) => v.erros),
    avisos: minhas.flatMap((v) => v.avisos),
  };
}

export async function publishFacebookItem(
  cfg: Record<string, string>, token: string, listing: ListingWithProduct,
  fetcher: typeof fetch = fetch,
): Promise<PublishResult> {
  const produto = listing.product;
  const item = facebookItemPayload(cfg, listing);
  const id = item.data.id;

  const { handle, validacao } = await enviarItensFacebook(cfg, token, [item], fetcher);
  const imediatas = mensagensDe(validacao, id);
  // Recusa na validação síncrona é falha de verdade, com o motivo da Meta.
  // Sem isto o item ficaria marcado como publicado tendo sido rejeitado.
  if (imediatas.erros.length) {
    throw new OrderError(`A Meta recusou o item: ${imediatas.erros.join(" | ").slice(0, 300)}`);
  }
  if (!handle) {
    // "Um array vazio significa que nada foi ingerido": sem handle não há o
    // que consultar, e marcar como publicado seria mentira.
    throw new OrderError("A Meta não ingeriu o item e não devolveu identificador do envio.");
  }

  // A gravação é assíncrona: o POST só validou a forma. Uma consulta imediata
  // costuma trazer o lote em processamento, mas traz a recusa quando ela é
  // rápida.
  //
  // LIMITE DECLARADO: só uma consulta, sem espera. Recusa que aparecer depois
  // não é capturada aqui; ela fica visível quando a próxima rodada reenviar o
  // item, e é por isso que o `handle` fica registrado.
  let consulta: Awaited<ReturnType<typeof consultarLoteFacebook>> | null = null;
  try {
    consulta = await consultarLoteFacebook(cfg, token, handle, fetcher);
  } catch {
    // Falha de CONSULTA não derruba um item que a Meta já aceitou: o envio é o
    // que importa, a consulta é diagnóstico.
    consulta = null;
  }

  const posteriores = mensagensDe(consulta?.validacao ?? [], id);
  if (posteriores.erros.length) {
    throw new OrderError(`A Meta recusou o item: ${posteriores.erros.join(" | ").slice(0, 300)}`);
  }

  const estado: EstadoFacebook = {
    catalogo: facebookCatalogId(cfg),
    handle,
    status: consulta?.status ?? null,
    mensagens: [...imediatas.avisos, ...posteriores.avisos].slice(0, 10),
  };

  return {
    externalListingId: id,
    // A Meta não devolve o item gravado nesta resposta: registramos o que foi
    // enviado, que é o que ela vai ingerir.
    price: Number(produto.price).toFixed(2),
    stock: produto.stock,
    externalStatus: consulta?.status ?? "queued",
    sentAttributes: estado,
  };
}
