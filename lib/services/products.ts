import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";
import { OrderError, textInput } from "../domain/order-input";
import { inteiroNaoNegativo, parseProduct } from "../domain/product-input";
import { assertOrgAdmin } from "./access";
import { assertActor, UserActor } from "./actor";
import { serializable } from "./transactions";

/**
 * Catálogo da organização.
 *
 * Toda escrita aqui pode mudar o que precisa ir para os canais, então cada uma
 * termina marcando os anúncios do produto como pendentes. A marca é ligada na
 * MESMA transação da mudança: se ficasse de fora, uma falha entre as duas
 * deixaria o catálogo dizendo um preço e os canais anunciando outro, sem nada
 * registrado para corrigir depois.
 */

/// Campos cujo valor viaja para o provedor. Mexer em qualquer um deles torna o
/// anúncio desatualizado.
const CAMPOS_PUBLICADOS = [
  "title", "description", "price", "stock", "imageUrl", "brand", "condition", "category", "active",
] as const;

/// Liga a marca de pendência nos anúncios do produto e os torna elegíveis já.
/// `attempts` volta a zero porque a mudança é um fato novo: o backoff herdado
/// de uma falha anterior não deve atrasar a tentativa desta.
export async function marcarAnunciosPendentes(tx: Prisma.TransactionClient, productId: string) {
  return tx.listing.updateMany({
    where: { productId, status: { in: ["PUBLISHING", "PUBLISHED"] } },
    data: { needsSync: true, availableAt: new Date(), attempts: 0 },
  });
}

export async function createProduct(db: PrismaClient, actor: UserActor, input: unknown) {
  const dados = parseProduct(input);
  return serializable(db, async (tx) => {
    await assertOrgAdmin(tx, actor);
    const jaExiste = await tx.product.findUnique({
      where: { organizationId_sku: { organizationId: actor.organizationId, sku: dados.sku } },
      select: { id: true },
    });
    if (jaExiste) throw new OrderError("Já existe um produto com o SKU " + dados.sku + ".");

    const product = await tx.product.create({
      data: { ...dados, organizationId: actor.organizationId },
      select: { id: true, sku: true, title: true },
    });
    await tx.auditLog.create({ data: {
      action: "CREATE", entity: "PRODUCT", entityId: product.id,
      organizationId: actor.organizationId, userId: actor.userId,
      details: "Produto " + product.sku + " criado.",
      newData: { ...dados, price: dados.price.toFixed(2) },
    } });
    return product;
  });
}

export async function updateProduct(db: PrismaClient, actor: UserActor, productId: string, input: unknown) {
  const id = textInput(productId, "Produto");
  const dados = parseProduct(input);
  return serializable(db, async (tx) => {
    await assertOrgAdmin(tx, actor);
    // A organização vem da sessão e entra no filtro: id de produto vindo de um
    // formulário não alcança o catálogo de outro tenant.
    const atual = await tx.product.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!atual) throw new OrderError("Produto não encontrado.");

    if (dados.sku !== atual.sku) {
      const conflito = await tx.product.findUnique({
        where: { organizationId_sku: { organizationId: actor.organizationId, sku: dados.sku } },
        select: { id: true },
      });
      if (conflito) throw new OrderError("Já existe um produto com o SKU " + dados.sku + ".");
    }

    const product = await tx.product.update({
      where: { id }, data: dados, select: { id: true, sku: true, title: true },
    });

    const mudouPublicado = CAMPOS_PUBLICADOS.some((campo) => campo === "price"
      ? !atual.price.equals(dados.price)
      : atual[campo] !== dados[campo]);
    const pendentes = mudouPublicado ? (await marcarAnunciosPendentes(tx, id)).count : 0;

    await tx.auditLog.create({ data: {
      action: "UPDATE", entity: "PRODUCT", entityId: id,
      organizationId: actor.organizationId, userId: actor.userId,
      details: "Produto " + product.sku + " atualizado."
        + (pendentes ? " " + pendentes + " anúncio(s) para ressincronizar." : ""),
      oldData: { sku: atual.sku, title: atual.title, price: atual.price.toFixed(2), stock: atual.stock, active: atual.active },
      newData: { ...dados, price: dados.price.toFixed(2) },
    } });
    return { ...product, anunciosPendentes: pendentes };
  });
}

/// Ajuste direto de estoque, sem passar pelo formulário inteiro. É o caminho
/// que a operação usa no dia a dia.
export async function setProductStock(db: PrismaClient, actor: UserActor, productId: string, stock: unknown) {
  const id = textInput(productId, "Produto");
  const novo = inteiroNaoNegativo(stock, "Estoque");
  return serializable(db, async (tx) => {
    await assertActor(tx, actor);
    const atual = await tx.product.findFirst({
      where: { id, organizationId: actor.organizationId }, select: { id: true, sku: true, stock: true },
    });
    if (!atual) throw new OrderError("Produto não encontrado.");
    if (atual.stock === novo) return { id, sku: atual.sku, stock: novo, anunciosPendentes: 0 };

    await tx.product.update({ where: { id }, data: { stock: novo } });
    const pendentes = (await marcarAnunciosPendentes(tx, id)).count;
    await tx.auditLog.create({ data: {
      action: "UPDATE", entity: "PRODUCT", entityId: id,
      organizationId: actor.organizationId, userId: actor.userId,
      details: "Estoque de " + atual.sku + ": " + atual.stock + " para " + novo + ".",
      oldData: { stock: atual.stock }, newData: { stock: novo },
    } });
    return { id, sku: atual.sku, stock: novo, anunciosPendentes: pendentes };
  });
}

/**
 * Movimento de estoque causado por uma venda que chegou de um canal.
 *
 * Recebe `tx` em vez de abrir a sua: roda na MESMA transação que grava a venda,
 * porque se a venda for gravada e a baixa não, os outros canais seguem
 * anunciando um item que já foi vendido.
 *
 * Nunca desce abaixo de zero. Duas vendas simultâneas do último item são um
 * fato do mundo, não um erro de programa: o estoque para em zero e os canais
 * recebem zero.
 */
async function moverEstoque(tx: Prisma.TransactionClient, organizationId: string, itens: {
  sku: string | null; quantity: number;
}[], sinal: 1 | -1) {
  const porSku = new Map<string, number>();
  for (const item of itens) {
    const chave = (item.sku ?? "").trim().toUpperCase();
    if (!chave) continue;
    porSku.set(chave, (porSku.get(chave) ?? 0) + item.quantity);
  }
  if (!porSku.size) return { movidos: 0, anunciosPendentes: 0 };

  let movidos = 0;
  let anunciosPendentes = 0;
  for (const [sku, quantidade] of porSku) {
    const produto = await tx.product.findUnique({
      where: { organizationId_sku: { organizationId, sku } }, select: { id: true, stock: true },
    });
    // Item vendido fora do catálogo não é erro: o canal pode ter anúncios que
    // não nasceram aqui.
    if (!produto) continue;
    const novo = Math.max(0, produto.stock + sinal * quantidade);
    if (novo === produto.stock) continue;
    await tx.product.update({ where: { id: produto.id }, data: { stock: novo } });
    anunciosPendentes += (await marcarAnunciosPendentes(tx, produto.id)).count;
    movidos++;
  }
  return { movidos, anunciosPendentes };
}

/// Venda nova: tira do estoque. Chamado só na criação da venda — reenviar o
/// mesmo pedido não pode debitar duas vezes.
export function baixarEstoquePorVenda(tx: Prisma.TransactionClient, organizationId: string, itens: {
  sku: string | null; quantity: number;
}[]) {
  return moverEstoque(tx, organizationId, itens, -1);
}

/// Venda cancelada: devolve ao estoque. Sem isto, todo cancelamento tiraria o
/// item das vitrines para sempre.
export function devolverEstoquePorCancelamento(tx: Prisma.TransactionClient, organizationId: string, itens: {
  sku: string | null; quantity: number;
}[]) {
  return moverEstoque(tx, organizationId, itens, 1);
}

export async function listProducts(db: PrismaClient, actor: UserActor) {
  return db.product.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { createdAt: "desc" },
    include: {
      listings: {
        select: {
          id: true, status: true, needsSync: true, externalListingId: true,
          publishedPrice: true, publishedStock: true, lastPublishedAt: true, lastError: true,
          marketplace: { select: { id: true, name: true, code: true } },
        },
        orderBy: { marketplace: { name: "asc" } },
      },
    },
  });
}
