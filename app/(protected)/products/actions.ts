"use server";
import { revalidatePath } from "next/cache";
import { currentActor } from "@/lib/current-actor";
import { prisma } from "@/lib/prisma";
import { OrderError, textInput } from "@/lib/domain/order-input";
import { providerPublisher } from "@/lib/integrations/publish";
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
export async function publicar(productId: string, marketplaceIds: string[]) {
  const actor = await currentActor();
  try {
    const pedidos = await requestPublication(prisma, actor, productId, marketplaceIds);
    let sincronizados = 0;
    try {
      const resultado = await syncListings(prisma, providerPublisher(prisma), pedidos.length);
      sincronizados = resultado.publicados + resultado.atualizados;
    } catch {
      // Fica para o agendador; o estado no banco é o que manda.
    }
    revalidatePath("/products");
    return { ok: true as const, canais: pedidos.map((p) => p.canal), sincronizados };
  } catch (erro) {
    return { ok: false as const, erro: mensagem(erro) };
  }
}

/// Reenvia o que estiver pendente, na mão. Serve para destravar sem esperar o
/// agendador depois de corrigir a causa de uma falha.
export async function sincronizarAgora() {
  await currentActor();
  try {
    const resultado = await syncListings(prisma, providerPublisher(prisma));
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
