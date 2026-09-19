import "server-only";
import { randomUUID } from "node:crypto";
import { Listing, PrismaClient, Product } from "@prisma/client";
import { providerDoCanal } from "../domain/marketplace-provider";
import { OrderError, textInput } from "../domain/order-input";
import { assertOrgAdmin } from "./access";
import { UserActor } from "./actor";
import { serializable } from "./transactions";

/**
 * Publicação de produtos nos canais.
 *
 * O desenho é de estado desejado, não de fila de comandos. O produto diz o que
 * deveria estar no canal; o anúncio guarda o que o provedor confirmou. O
 * trabalhador olha a diferença e manda o valor ABSOLUTO — nunca "some 3 ao
 * estoque". Com valor absoluto, repetir a mesma sincronização não faz mal, e
 * três mudanças de preço seguidas custam uma chamada só, não três.
 *
 * É o mesmo raciocínio da conciliação de pedidos, na direção oposta.
 */

/// Depois disso, o anúncio para de ser tentado e espera intervenção. O mesmo
/// teto do processamento de eventos, pelo mesmo motivo: sem ele, um anúncio
/// que o provedor nunca vai aceitar consome a rodada para sempre.
export const MAX_SYNC_ATTEMPTS = 8;
/// O lease precisa durar mais que a chamada ao provedor, senão outra rodada
/// pega o mesmo anúncio enquanto a primeira ainda está publicando.
const LEASE_MS = 120000;

export type ListingWithProduct = Listing & { product: Product };

/// O que o adapter do provedor devolve depois de publicar ou atualizar. São os
/// valores que o provedor CONFIRMOU, e não os que pedimos: se ele arredondar o
/// preço ou limitar o estoque, é o número dele que fica registrado.
export interface PublishResult {
  externalListingId: string;
  price: string;
  stock: number;
}

export type ListingPublisher = (listing: ListingWithProduct) => Promise<PublishResult>;

/**
 * Pede a publicação de um produto em canais.
 *
 * Idempotente: pedir de novo num canal já publicado apenas marca o anúncio como
 * pendente, o que faz o trabalhador reenviar os valores atuais. Não cria um
 * segundo anúncio, porque o par (produto, canal) é único.
 */
export async function requestPublication(
  db: PrismaClient, actor: UserActor, productId: string, marketplaceIds: string[],
) {
  const id = textInput(productId, "Produto");
  if (!Array.isArray(marketplaceIds) || !marketplaceIds.length || marketplaceIds.length > 50) {
    throw new OrderError("Selecione ao menos um canal.");
  }
  const canais = marketplaceIds.map((valor) => textInput(valor, "Canal"));

  return serializable(db, async (tx) => {
    await assertOrgAdmin(tx, actor);
    const produto = await tx.product.findFirst({
      where: { id, organizationId: actor.organizationId },
      select: { id: true, sku: true, active: true },
    });
    if (!produto) throw new OrderError("Produto não encontrado.");
    // Publicar o que está desativado anunciaria algo que não se quer vender.
    if (!produto.active) throw new OrderError("Produto desativado não pode ser publicado.");

    const marketplaces = await tx.marketplace.findMany({
      where: { id: { in: canais }, organizationId: actor.organizationId, active: true },
      select: { id: true, name: true, code: true },
    });
    if (marketplaces.length !== canais.length) throw new OrderError("Canal não encontrado ou inativo.");

    const pedidos: { canal: string; listingId: string }[] = [];
    for (const marketplace of marketplaces) {
      // Sem provedor conhecido não há para onde publicar. O erro nomeia o canal
      // porque a tela oferece vários de uma vez.
      if (!providerDoCanal(marketplace.code)) {
        throw new OrderError("O canal " + marketplace.name + " não tem integração de publicação.");
      }
      // A conexão é o que carrega a credencial: sem ela a publicação falharia
      // no trabalhador, longe de quem apertou o botão.
      const conexao = await tx.marketplaceConnection.findFirst({
        where: { marketplaceId: marketplace.id, status: "ACTIVE" }, select: { id: true },
      });
      if (!conexao) throw new OrderError("O canal " + marketplace.name + " não está conectado.");

      const listing = await tx.listing.upsert({
        where: { productId_marketplaceId: { productId: id, marketplaceId: marketplace.id } },
        // Um anúncio já publicado continua publicado: só volta a ficar pendente.
        update: { needsSync: true, availableAt: new Date(), attempts: 0, lastError: null },
        create: { productId: id, marketplaceId: marketplace.id, status: "PUBLISHING", needsSync: true },
        select: { id: true, status: true },
      });
      // Um anúncio que tinha desistido volta à fila por pedido explícito.
      if (listing.status === "FAILED" || listing.status === "PAUSED" || listing.status === "CLOSED") {
        await tx.listing.update({ where: { id: listing.id }, data: { status: "PUBLISHING" } });
      }
      pedidos.push({ canal: marketplace.name, listingId: listing.id });
    }

    await tx.auditLog.create({ data: {
      action: "UPDATE", entity: "PRODUCT", entityId: id,
      organizationId: actor.organizationId, userId: actor.userId,
      details: "Publicação de " + produto.sku + " pedida em: "
        + pedidos.map((p) => p.canal).join(", ") + ".",
      newData: { canais: pedidos.map((p) => p.canal) },
    } });
    return pedidos;
  });
}

/// Um anúncio publicado está em dia quando o que o provedor confirmou é o que
/// o produto diz hoje. Comparado em Decimal: 10.00 e 10.0 são o mesmo preço.
export function estaEmDia(listing: ListingWithProduct) {
  if (listing.status !== "PUBLISHED") return false;
  if (listing.publishedStock !== listing.product.stock) return false;
  return listing.publishedPrice !== null && listing.publishedPrice.equals(listing.product.price);
}

/**
 * Uma rodada do trabalhador.
 *
 * Reclama cada anúncio com lease antes de falar com o provedor, do mesmo jeito
 * que o outbox de entrada: duas rodadas simultâneas não publicam o mesmo
 * anúncio duas vezes.
 */
export async function syncListings(db: PrismaClient, publish: ListingPublisher, limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new OrderError("Limite de sincronização inválido.");
  }
  const agora = new Date();
  const candidatos = await db.listing.findMany({
    where: {
      needsSync: true,
      status: { in: ["PUBLISHING", "PUBLISHED"] },
      availableAt: { lte: agora },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: agora } }],
    },
    include: { product: true },
    orderBy: { availableAt: "asc" },
    take: limit,
  });

  let publicados = 0;
  let atualizados = 0;
  let emDia = 0;
  let falhas = 0;
  for (const listing of candidatos) {
    const eraPublicado = listing.status === "PUBLISHED";
    // Nada mudou de fato: desliga a marca sem gastar chamada no provedor.
    if (estaEmDia(listing)) {
      await db.listing.updateMany({
        where: { id: listing.id, needsSync: true }, data: { needsSync: false, lastError: null },
      });
      emDia++;
      continue;
    }

    const leaseToken = randomUUID();
    const instante = new Date();
    const reclamado = await db.listing.updateMany({
      where: {
        id: listing.id, needsSync: true, availableAt: { lte: instante },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: instante } }],
      },
      data: {
        leaseToken, leaseUntil: new Date(instante.getTime() + LEASE_MS), attempts: { increment: 1 },
      },
    });
    if (!reclamado.count) continue;

    try {
      const resultado = await publish(listing);
      // O lease entra no filtro: se outra rodada tomou o anúncio enquanto esta
      // falava com o provedor, quem grava é ela, não nós.
      const gravou = await db.listing.updateMany({
        where: { id: listing.id, leaseToken },
        data: {
          status: "PUBLISHED",
          externalListingId: resultado.externalListingId,
          publishedPrice: resultado.price,
          publishedStock: resultado.stock,
          lastPublishedAt: new Date(),
          needsSync: false, leaseUntil: null, leaseToken: null, lastError: null, attempts: 0,
        },
      });
      if (gravou.count) {
        if (eraPublicado) atualizados++; else publicados++;
      }
    } catch (error) {
      const permanente = error instanceof OrderError;
      const tentativas = listing.attempts + 1;
      await db.listing.updateMany({
        where: { id: listing.id, leaseToken },
        data: {
          // Erro de domínio não melhora com o tempo: desiste e espera correção.
          status: permanente || tentativas >= MAX_SYNC_ATTEMPTS ? "FAILED" : listing.status,
          needsSync: !(permanente || tentativas >= MAX_SYNC_ATTEMPTS),
          availableAt: new Date(Date.now() + Math.min(3600000, 1000 * 2 ** tentativas)),
          leaseUntil: null, leaseToken: null,
          // Só mensagem nossa: a do provedor pode carregar credencial ou corpo.
          lastError: permanente ? (error as OrderError).message : "PUBLICACAO_FALHOU",
        },
      });
      falhas++;
    }
  }
  return { candidatos: candidatos.length, publicados, atualizados, emDia, falhas };
}
