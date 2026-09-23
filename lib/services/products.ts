import "server-only";
import { Prisma, PrismaClient, StockMovementReason } from "@prisma/client";
import { OrderError, textInput } from "../domain/order-input";
import {
  imagem, inteiroNaoNegativo, MAX_IMAGENS, parseProduct, referenciaDeImagem,
} from "../domain/product-input";
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
  "title", "description", "price", "stock", "brand", "condition", "category", "active",
] as const;

/**
 * Para cada entrada do álbum, a linha que já existe -- ou `null`, se é nova.
 *
 * Duas formas casam com uma linha existente, e as duas importam:
 *
 * - `ref:<id>`: o formulário mandando "esta é a foto que já está aí". É o que
 *   evita a base64 viajar de novo a cada salvamento.
 * - a **mesma URL**: quem cadastra por endereço externo continua mandando o
 *   endereço, e ele é identificador estável. Tratar isso como imagem nova
 *   reescreveria a linha (trocando o id, que é endereço público) e marcaria os
 *   anúncios para ressincronizar sem nada ter mudado.
 */
function resolverAlbum(
  atuais: { id: string; url: string }[], images: string[],
): (string | null)[] {
  const porId = new Map(atuais.map((i) => [i.id, i]));
  const porUrl = new Map<string, string>();
  for (const i of atuais) if (!porUrl.has(i.url)) porUrl.set(i.url, i.id);

  const usados = new Set<string>();
  return images.map((entrada) => {
    const ref = referenciaDeImagem(entrada);
    if (ref !== null) {
      // Aceitar um id que não é deste produto deixaria um formulário adotar a
      // imagem de outro catálogo.
      if (!porId.has(ref) || usados.has(ref)) {
        throw new OrderError("Imagem não encontrada neste produto.");
      }
      usados.add(ref);
      return ref;
    }
    const id = porUrl.get(entrada);
    if (id && !usados.has(id)) {
      usados.add(id);
      return id;
    }
    return null;
  });
}

/**
 * Grava o álbum preservando as linhas que continuam nele.
 *
 * Duas coisas dependem disso, e as duas quebraram com a versão anterior, que
 * apagava tudo e recriava:
 *
 * 1. **O id da imagem é endereço público.** O anúncio no catálogo do Meta leva
 *    `/api/product-images/{id}`. Recriar as linhas a cada salvamento trocava o
 *    id, e toda URL já anunciada virava 404 -- sem nenhum erro deste lado.
 * 2. **A foto não viaja de novo.** O que chega aqui para uma imagem que já
 *    existe é `ref:<id>`, não os megabytes dela. É o que permite salvar um
 *    produto com dez fotos sem estourar o corpo da requisição.
 *
 * Entrada com `ref:` que não seja deste produto é recusada: aceitar seria
 * deixar um formulário adotar a imagem de outro catálogo.
 */
async function gravarAlbum(tx: Prisma.TransactionClient, productId: string, images: string[]) {
  const atuais = await tx.productImage.findMany({
    where: { productId }, select: { id: true, url: true },
  });
  const resolvidas = resolverAlbum(atuais, images);

  const manter = resolvidas.filter((r) => r !== null) as string[];
  const novas: { url: string; position: number }[] = [];
  resolvidas.forEach((id, position) => {
    if (id === null) novas.push({ url: images[position], position });
  });

  // O que saiu do álbum sai do banco. Sobra ordenada depois, para a posição
  // não colidir com a de uma linha que ainda será apagada.
  await tx.productImage.deleteMany({
    where: { productId, id: { notIn: manter.length ? manter : ["-"] } },
  });
  // Posição temporária negativa antes da definitiva: `(productId, position)`
  // é único, e mover a imagem 2 para a 0 esbarraria na que ainda está lá.
  for (const [indice, id] of manter.entries()) {
    await tx.productImage.update({ where: { id }, data: { position: -1 - indice } });
  }
  for (const [position, id] of resolvidas.entries()) {
    if (id !== null) await tx.productImage.update({ where: { id }, data: { position } });
  }
  if (novas.length) {
    await tx.productImage.createMany({
      data: novas.map((n) => ({ productId, position: n.position, url: n.url })),
    });
  }
}

/**
 * Anexa UMA imagem ao fim do álbum.
 *
 * É por aqui que a foto entra, e é o caminho que tira o álbum da requisição de
 * salvar: uma imagem por requisição cabe no limite; o álbum inteiro, não.
 *
 * Marca os anúncios para ressincronizar, porque mudar o álbum muda o que o
 * canal precisa receber -- e quem salva o produto depois vê o álbum já igual
 * ao que está no banco, então não marcaria nada.
 */
export async function appendProductImage(
  db: PrismaClient, actor: UserActor, productId: string, dataUri: unknown,
) {
  const id = textInput(productId, "Produto");
  const url = imagem(dataUri);
  if (!url) throw new OrderError("Selecione um arquivo de imagem.");
  if (referenciaDeImagem(url) !== null) throw new OrderError("Imagem inválida.");

  return serializable(db, async (tx) => {
    await assertOrgAdmin(tx, actor);
    const produto = await tx.product.findFirst({
      where: { id, organizationId: actor.organizationId }, select: { id: true, sku: true },
    });
    if (!produto) throw new OrderError("Produto não encontrado.");

    const existentes = await tx.productImage.findMany({
      where: { productId: id }, select: { position: true, url: true },
      orderBy: { position: "desc" },
    });
    if (existentes.length >= MAX_IMAGENS) {
      throw new OrderError(`O álbum aceita no máximo ${MAX_IMAGENS} imagens.`);
    }
    // A mesma foto duas vezes é engano de quem cadastra, e o álbum já tratava
    // repetição descartando em vez de recusar.
    const repetida = existentes.find((i) => i.url === url);
    if (repetida) return { id: null, position: repetida.position, repetida: true };

    const imagemNova = await tx.productImage.create({
      data: { productId: id, url, position: (existentes[0]?.position ?? -1) + 1 },
      select: { id: true, position: true },
    });
    const pendentes = (await marcarAnunciosPendentes(tx, id)).count;
    await tx.auditLog.create({ data: {
      action: "UPDATE", entity: "PRODUCT", entityId: id,
      organizationId: actor.organizationId, userId: actor.userId,
      details: `Imagem acrescentada ao produto ${produto.sku}.`
        + (pendentes ? ` ${pendentes} anúncio(s) para ressincronizar.` : ""),
    } });
    return { ...imagemNova, repetida: false };
  });
}

/// Registra a mudança de estoque junto com o saldo que ficou.
///
/// Sempre na mesma transação de quem mudou o estoque: um movimento que não
/// fosse gravado junto tornaria o histórico mentira, e o histórico é o que
/// reconstrói o saldo de cada dia no painel.
async function registrarMovimento(tx: Prisma.TransactionClient, dados: {
  productId: string; organizationId: string; delta: number; balance: number;
  reason: StockMovementReason; saleId?: string;
}) {
  if (!dados.delta) return;
  await tx.stockMovement.create({ data: dados });
}

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
  const { images, ...dados } = parseProduct(input);
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
    await gravarAlbum(tx, product.id, images);
    await registrarMovimento(tx, {
      productId: product.id, organizationId: actor.organizationId,
      delta: dados.stock, balance: dados.stock, reason: "CREATION",
    });
    await tx.auditLog.create({ data: {
      action: "CREATE", entity: "PRODUCT", entityId: product.id,
      organizationId: actor.organizationId, userId: actor.userId,
      details: "Produto " + product.sku + " criado.",
      // O álbum entra como contagem: um data URI de megabytes no registro de
      // auditoria inflaria a tabela sem dizer nada útil.
      newData: { ...dados, price: dados.price.toFixed(2), imagens: images.length },
    } });
    return product;
  });
}

export async function updateProduct(db: PrismaClient, actor: UserActor, productId: string, input: unknown) {
  const id = textInput(productId, "Produto");
  const { images, ...dados } = parseProduct(input);
  return serializable(db, async (tx) => {
    await assertOrgAdmin(tx, actor);
    // A organização vem da sessão e entra no filtro: id de produto vindo de um
    // formulário não alcança o catálogo de outro tenant.
    const atual = await tx.product.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: { images: { orderBy: { position: "asc" }, select: { id: true, url: true } } },
    });
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

    if (dados.stock !== atual.stock) {
      await registrarMovimento(tx, {
        productId: id, organizationId: actor.organizationId,
        delta: dados.stock - atual.stock, balance: dados.stock, reason: "PRODUCT_EDIT",
      });
    }

    // Ordem conta: trocar a principal muda o que o provedor recebe, mesmo que
    // o conjunto de imagens seja o mesmo. A comparação é por ID, e não por
    // conteúdo: o que chega para uma imagem que já existe é `ref:<id>`, e
    // comparar isso com a base64 diria "mudou" a cada salvamento.
    const albumAntigo = atual.images.map((i) => i.id);
    const albumNovo = resolverAlbum(atual.images, images);
    const mudouAlbum = albumAntigo.length !== albumNovo.length
      // `null` é imagem nova: só de existir já mudou o álbum.
      || albumNovo.some((id, i) => id === null || id !== albumAntigo[i]);
    if (mudouAlbum) await gravarAlbum(tx, id, images);

    const mudouPublicado = mudouAlbum || CAMPOS_PUBLICADOS.some((campo) => campo === "price"
      ? !atual.price.equals(dados.price)
      : atual[campo] !== dados[campo]);
    const pendentes = mudouPublicado ? (await marcarAnunciosPendentes(tx, id)).count : 0;

    await tx.auditLog.create({ data: {
      action: "UPDATE", entity: "PRODUCT", entityId: id,
      organizationId: actor.organizationId, userId: actor.userId,
      details: "Produto " + product.sku + " atualizado."
        + (pendentes ? " " + pendentes + " anúncio(s) para ressincronizar." : ""),
      oldData: {
        sku: atual.sku, title: atual.title, price: atual.price.toFixed(2),
        stock: atual.stock, active: atual.active, imagens: albumAntigo.length,
      },
      newData: { ...dados, price: dados.price.toFixed(2), imagens: images.length },
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
    await registrarMovimento(tx, {
      productId: id, organizationId: actor.organizationId,
      delta: novo - atual.stock, balance: novo, reason: "MANUAL",
    });
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
}[], sinal: 1 | -1, saleId?: string) {
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
    await registrarMovimento(tx, {
      productId: produto.id, organizationId, delta: novo - produto.stock, balance: novo,
      reason: sinal < 0 ? "SALE" : "CANCELLATION", saleId,
    });
    anunciosPendentes += (await marcarAnunciosPendentes(tx, produto.id)).count;
    movidos++;
  }
  return { movidos, anunciosPendentes };
}

/// Venda nova: tira do estoque. Chamado só na criação da venda — reenviar o
/// mesmo pedido não pode debitar duas vezes.
export function baixarEstoquePorVenda(tx: Prisma.TransactionClient, organizationId: string, itens: {
  sku: string | null; quantity: number;
}[], saleId: string) {
  return moverEstoque(tx, organizationId, itens, -1, saleId);
}

/// Venda cancelada: devolve ao estoque. Sem isto, todo cancelamento tiraria o
/// item das vitrines para sempre.
export function devolverEstoquePorCancelamento(tx: Prisma.TransactionClient, organizationId: string, itens: {
  sku: string | null; quantity: number;
}[], saleId: string) {
  return moverEstoque(tx, organizationId, itens, 1, saleId);
}

export async function listProducts(db: PrismaClient, actor: UserActor) {
  return db.product.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { createdAt: "desc" },
    include: {
      images: { orderBy: { position: "asc" }, select: { id: true, url: true, position: true } },
      listings: {
        select: {
          id: true, status: true, needsSync: true, externalListingId: true, categoryExternalId: true,
          externalStatus: true,
          publishedPrice: true, publishedStock: true, lastPublishedAt: true, lastError: true,
          connection: { select: { externalAccountId: true } },
          marketplace: { select: { id: true, name: true, code: true } },
        },
        orderBy: { marketplace: { name: "asc" } },
      },
    },
  });
}
