import "server-only";
import { OrderError } from "../../domain/order-input";
import { ListingWithProduct, PublishResult } from "../../services/listings";
import { AnuncianteOlx, consultarImportacaoOlx, importarAnunciosOlx } from "./client";

/**
 * Publicação de anúncio na OLX.
 *
 * Quatro decisões que valem registro, porque cada uma nasce de uma diferença
 * real entre classificados e marketplace:
 *
 * 1. **O identificador do anúncio é NOSSO.** A OLX casa a importação pelo `id`
 *    que mandamos: reenviar o mesmo id com preço novo é edição, não anúncio
 *    novo. É o que faz o modelo de estado desejado funcionar aqui sem precisar
 *    do id que a OLX gera. O `list_id` dela é informativo, e vai junto da URL
 *    pública no registro do que foi enviado.
 * 2. **Imagem só por URL.** A OLX busca a imagem no endereço informado; não há
 *    upload. É o oposto da Shopee, e o oposto do que o nosso álbum guarda
 *    quando alguém sobe arquivo do computador — então imagem embutida é
 *    recusada por nós, com mensagem dizendo o que fazer.
 * 3. **Preço é inteiro, em reais.** Sem centavos, é o que o contrato aceita.
 *    Arredondamos e declaramos: um produto de R$ 79,90 anuncia R$ 80.
 * 4. **Produto desativado vira `delete`.** É a única forma de despublicar por
 *    aqui, e `active` entra na impressão do anúncio, então desativar no
 *    catálogo derruba o anúncio na rodada seguinte.
 *
 * Telefone e CEP vêm do cadastro da organização (tela de Organizações), porque
 * são do anunciante e não do produto -- e porque o mesmo deploy atende vários
 * tenants.
 */

/// A OLX aceita até 20 imagens por anúncio.
const MAX_IMAGENS = 20;

/// O id que a OLX usa para casar a importação. É o id do anúncio aqui: único
/// por construção, estável, e não muda se o SKU for corrigido.
export function idDoAnuncioOlx(listing: ListingWithProduct) {
  return listing.id;
}

function categoriaDe(listing: ListingWithProduct) {
  const categoria = (listing.categoryExternalId ?? "").trim();
  if (!/^\d{1,10}$/.test(categoria)) {
    throw new OrderError(
      "Informe o código numérico da categoria da OLX na aba Categoria antes de publicar.");
  }
  return Number(categoria);
}

function imagensDe(listing: ListingWithProduct) {
  const urls = listing.product.images.map((i) => i.url);
  if (!urls.length) throw new OrderError("A OLX exige ao menos uma imagem no anúncio.");
  const embutida = urls.find((url) => url.startsWith("data:"));
  if (embutida) {
    throw new OrderError(
      "A OLX busca a imagem pelo endereço e não aceita arquivo embutido. Cadastre a"
      + " imagem do produto por URL pública para publicar neste canal.");
  }
  const invalida = urls.find((url) => !/^https?:\/\//.test(url));
  if (invalida) throw new OrderError("Imagem com endereço inválido para a OLX.");
  return urls.slice(0, MAX_IMAGENS);
}

/// Monta o anúncio. Separado da chamada para ter teste sobre a forma exata do
/// corpo -- que é onde o contrato da OLX é mais exigente.
export function olxAdPayload(listing: ListingWithProduct, anunciante: AnuncianteOlx) {
  const produto = listing.product;
  const { telefone, cep } = anunciante;
  if (telefone.length < 10 || telefone.length > 11 || cep.length !== 8) {
    // Nomeia onde se corrige: a recusa do provedor falaria de campo inválido,
    // sem dizer que o dado que falta é o da empresa, noutra tela.
    throw new OrderError(
      "Complete o telefone e o CEP da organização em Organizações para publicar na OLX.");
  }

  if (!produto.description.trim()) {
    // O provedor exige `Body`; recusar aqui nomeia o campo, enquanto a recusa
    // dele viria como validação genérica do anúncio.
    throw new OrderError("A OLX exige descrição no anúncio. Preencha a descrição do produto.");
  }

  const preco = Math.round(Number(produto.price.toFixed(2)));
  if (!Number.isSafeInteger(preco) || preco < 1) {
    throw new OrderError("A OLX aceita preço inteiro em reais, a partir de R$ 1.");
  }

  return {
    id: idDoAnuncioOlx(listing),
    // Produto desativado sai do ar: é o único jeito de despublicar por aqui.
    operation: produto.active ? "insert" : "delete",
    category: categoriaDe(listing),
    Subject: produto.title,
    Body: produto.description,
    Phone: Number(telefone),
    // Venda, não aluguel. O catálogo não tem locação no domínio.
    type: "s",
    price: preco,
    zipcode: cep,
    images: imagensDe(listing),
    phone_hidden: false,
  };
}

/// O que ficou registrado da importação, para a tela poder mostrar o anúncio
/// publicado. Vai em `publishedAttributes`.
interface EstadoOlx {
  importacao: string;
  listId: string | null;
  url: string | null;
  mensagens: string[];
}

export async function publishOlxAd(
  token: string, listing: ListingWithProduct, anunciante: AnuncianteOlx,
  fetcher: typeof fetch = fetch,
): Promise<PublishResult> {
  const produto = listing.product;
  const anuncio = olxAdPayload(listing, anunciante);
  const { token: importacao } = await importarAnunciosOlx(token, [anuncio], fetcher);

  // A importação é assíncrona: o PUT só validou a forma. Uma consulta imediata
  // costuma trazer `queued`, mas traz `refused` quando a recusa é rápida -- e
  // recusa precisa virar falha, com o motivo do provedor, em vez de anúncio
  // marcado como publicado.
  //
  // LIMITE DECLARADO: só uma consulta, sem espera. Recusa que aparecer depois
  // não é capturada aqui; ela fica visível quando a próxima rodada reenviar o
  // anúncio, e é por isso que `importacao` fica registrada.
  let consulta: Awaited<ReturnType<typeof consultarImportacaoOlx>> | null = null;
  try {
    consulta = await consultarImportacaoOlx(token, importacao, fetcher);
  } catch {
    // Falha de CONSULTA não derruba um anúncio que a OLX já aceitou: o envio é
    // o que importa, a consulta é diagnóstico. A importação fica registrada, e
    // é por ela que se descobre o destino depois.
    consulta = null;
  }

  const primeiro = consulta?.anuncios[0] ?? null;
  const estado: EstadoOlx = {
    importacao,
    listId: primeiro?.listId ?? null,
    url: primeiro?.url ?? null,
    mensagens: primeiro?.mensagens ?? [],
  };

  // Recusa é falha de verdade, com o motivo do provedor. Sem isto o anúncio
  // ficaria marcado como publicado tendo sido rejeitado.
  if (primeiro && (primeiro.status === "refused" || primeiro.status === "error")) {
    throw new OrderError(
      `A OLX recusou o anúncio${primeiro.mensagens.length
        ? ": " + primeiro.mensagens.join(" | ").slice(0, 300) : "."}`);
  }

  return {
    externalListingId: anuncio.id,
    // A OLX não confirma preço nem estoque: registramos o que foi enviado, com
    // o preço já arredondado como ele foi.
    price: preco(anuncio.price),
    // Classificados não têm estoque. O anúncio existe ou não existe, então o
    // que se registra é o estoque do catálogo -- e a tela não passa a
    // impressão de que a OLX controla quantidade.
    stock: produto.stock,
    externalStatus: primeiro?.status ?? consulta?.geral ?? "queued",
    sentAttributes: estado,
  };
}

/// O preço enviado, em forma de dinheiro, para o registro do que foi publicado.
function preco(inteiro: number) {
  return inteiro.toFixed(2);
}
