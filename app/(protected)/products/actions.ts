"use server";
import { revalidatePath } from "next/cache";
import { currentActor } from "@/lib/current-actor";
import { prisma } from "@/lib/prisma";
import { OrderError, textInput } from "@/lib/domain/order-input";
import { MAX_IMAGE_BYTES, tipoDeImagemAceito } from "@/lib/domain/product-input";
import { providerPublisher } from "@/lib/integrations/publish";
import {
  listCategoryChildren, listCategoryTrees, searchCategories, setListingCategory, syncAllCategories,
} from "@/lib/services/categories";
import { requestPublication, syncListings } from "@/lib/services/listings";
import { createProduct, setProductStock, updateProduct } from "@/lib/services/products";

/**
 * Ações do catálogo.
 *
 * Toda autorização acontece nos serviços, dentro da transação, e não aqui: esta
 * camada só resolve quem está agindo e devolve o erro para a tela.
 */

// A mensagem de OrderError é escrita para ser lida por quem opera; qualquer
// outra falha vira texto genérico, para não vazar detalhe de infraestrutura.
function mensagem(erro: unknown) {
  return erro instanceof OrderError ? erro.message : "Não foi possível concluir a operação.";
}

export async function salvarProduto(input: unknown, productId?: string) {
  const actor = await currentActor();
  try {
    const produto = productId
      ? await updateProduct(prisma, actor, productId, input)
      : await createProduct(prisma, actor, input);
    revalidatePath("/products");
    return { ok: true as const, sku: produto.sku };
  } catch (erro) {
    return { ok: false as const, erro: mensagem(erro) };
  }
}

export async function ajustarEstoque(productId: string, stock: unknown) {
  const actor = await currentActor();
  try {
    const resultado = await setProductStock(prisma, actor, productId, stock);
    revalidatePath("/products");
    return { ok: true as const, stock: resultado.stock, anuncios: resultado.anunciosPendentes };
  } catch (erro) {
    return { ok: false as const, erro: mensagem(erro) };
  }
}

/**
 * Pede a publicação e já tenta sincronizar, sem esperar o agendador.
 *
 * A tentativa imediata é conveniência: quem apertou o botão vê o resultado. A
 * durabilidade continua sendo do estado gravado — se esta chamada morrer no
 * meio, o anúncio segue marcado como pendente e o agendador o pega. Por isso a
 * falha da sincronização não vira erro da ação: o pedido já foi registrado.
 */
export async function publicar(
  productId: string, marketplaceIds: string[], contas: Record<string, string> = {},
) {
  const actor = await currentActor();
  try {
    const pedidos = await requestPublication(prisma, actor, productId, marketplaceIds, contas);
    let sincronizados = 0;
    try {
      const resultado = await syncListings(
        prisma, providerPublisher(prisma), pedidos.length, actor.organizationId);
      sincronizados = resultado.publicados + resultado.atualizados;
    } catch {
      // Fica para o agendador; o estado no banco é o que manda.
    }
    revalidatePath("/products");
    return {
      ok: true as const,
      canais: pedidos.map((p) => p.canal + " (" + p.conta + ")"),
      sincronizados,
    };
  } catch (erro) {
    return { ok: false as const, erro: mensagem(erro) };
  }
}

/// Reenvia o que estiver pendente, na mão. Serve para destravar sem esperar o
/// agendador depois de corrigir a causa de uma falha.
export async function sincronizarAgora() {
  const actor = await currentActor();
  try {
    const resultado = await syncListings(
      prisma, providerPublisher(prisma), 10, actor.organizationId);
    revalidatePath("/products");
    return { ok: true as const, ...resultado };
  } catch (erro) {
    return { ok: false as const, erro: mensagem(erro) };
  }
}

export async function removerProduto(productId: string) {
  const actor = await currentActor();
  try {
    const id = textInput(productId, "Produto");
    // Um produto com anúncio publicado não some do canal ao sumir daqui: o
    // anúncio ficaria órfão, anunciando estoque que ninguém mais atualiza.
    const publicado = await prisma.listing.findFirst({
      where: { productId: id, product: { organizationId: actor.organizationId }, status: "PUBLISHED" },
      select: { marketplace: { select: { name: true } } },
    });
    if (publicado) {
      throw new OrderError(
        "Produto publicado em " + publicado.marketplace.name + ". Despublique no canal antes de remover.");
    }
    const { count } = await prisma.product.deleteMany({
      where: { id, organizationId: actor.organizationId },
    });
    if (!count) throw new OrderError("Produto não encontrado.");
    revalidatePath("/products");
    return { ok: true as const };
  } catch (erro) {
    return { ok: false as const, erro: mensagem(erro) };
  }
}

/**
 * Converte a imagem enviada do computador em data URI base64.
 *
 * Feito no servidor, e não no navegador, por dois motivos: o limite de tamanho
 * e o tipo do arquivo passam a ser conferidos onde o cliente não alcança, e o
 * fluxo fica igual ao do Sebo On-Line, que também converte e devolve o data
 * URI em vez de gravar. Devolver (em vez de gravar) deixa a mesma ação servir
 * o cadastro, onde o produto ainda não tem id, e a edição.
 */
export async function converterImagem(formData: FormData) {
  await currentActor();
  const arquivo = formData.get("file");
  if (!(arquivo instanceof File) || !arquivo.size) {
    return { ok: false as const, erro: "Selecione um arquivo de imagem." };
  }
  if (!tipoDeImagemAceito(arquivo.type)) {
    return { ok: false as const, erro: "Formato não aceito. Use PNG, JPEG, WEBP, GIF ou AVIF." };
  }
  if (arquivo.size > MAX_IMAGE_BYTES) {
    return {
      ok: false as const,
      erro: `A imagem tem ${(arquivo.size / (1024 * 1024)).toFixed(1)} MB e o limite é ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`,
    };
  }
  const base64 = Buffer.from(await arquivo.arrayBuffer()).toString("base64");
  return {
    ok: true as const,
    dataUri: `data:${arquivo.type};base64,${base64}`,
    bytes: arquivo.size,
  };
}

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

/// Canais com árvore importada, para a aba de categoria saber o que oferecer.
export async function canaisComCategoria() {
  const actor = await currentActor();
  return listCategoryTrees(prisma, actor);
}

/// Um nível da árvore. `parent` nulo devolve as raízes.
export async function filhosDaCategoria(marketplaceId: string, parentExternalId: string | null) {
  const actor = await currentActor();
  try {
    return { ok: true as const, itens: await listCategoryChildren(prisma, actor, marketplaceId, parentExternalId) };
  } catch (erro) {
    return { ok: false as const, erro: mensagem(erro) };
  }
}

/// Busca por texto: com 12 mil categorias, descer sete níveis na mão é pior
/// que digitar duas palavras.
export async function buscarCategorias(marketplaceId: string, termo: string) {
  const actor = await currentActor();
  try {
    return { ok: true as const, itens: await searchCategories(prisma, actor, marketplaceId, termo) };
  } catch (erro) {
    return { ok: false as const, erro: mensagem(erro) };
  }
}

export async function definirCategoria(
  productId: string, marketplaceId: string, categoryExternalId: string | null,
) {
  const actor = await currentActor();
  try {
    const resultado = await setListingCategory(prisma, actor, productId, marketplaceId, categoryExternalId);
    revalidatePath("/products");
    return { ok: true as const, ...resultado };
  } catch (erro) {
    return { ok: false as const, erro: mensagem(erro) };
  }
}

/// Reimporta as árvores na mão, para quando a importação que roda depois da
/// autorização não tiver completado.
export async function importarCategorias() {
  await currentActor();
  try {
    return { ok: true as const, ...(await syncAllCategories(prisma)) };
  } catch (erro) {
    return { ok: false as const, erro: mensagem(erro) };
  }
}
