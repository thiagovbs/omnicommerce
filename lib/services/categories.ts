import "server-only";
import { PrismaClient } from "@prisma/client";
import { providerDoCanal } from "../domain/marketplace-provider";
import { OrderError, textInput } from "../domain/order-input";
import { decryptSecret } from "../integrations/crypto";
import { fetchMercadoLivreCategories } from "../integrations/mercadolivre/categories";
import { assertOrgAdmin } from "./access";
import { UserActor } from "./actor";
import { serializable } from "./transactions";

/**
 * Cópia local da árvore de categorias de cada canal.
 *
 * Existe para a tela poder oferecer categoria e subcategoria sem depender do
 * provedor a cada clique: são 12 mil nós no Mercado Livre, e perguntar de novo
 * a cada nível deixaria o cadastro lento e sujeito à instabilidade da rede.
 *
 * A árvore muda pouco, então a cópia é atualizada quando a conexão é
 * autorizada e quando alguém pede — não há relógio correndo atrás dela.
 */

/// Depois disso a cópia é considerada velha e vale reimportar. Categoria não
/// muda de semana em semana; reimportar sem necessidade só gasta chamada.
export const VALIDADE_MS = 7 * 24 * 60 * 60 * 1000;
/// Tamanho do lote de inserção. 12 mil linhas numa tacada só estouram o limite
/// de parâmetros do driver.
const LOTE = 1000;

export type CategoryFetcher = (token: string) => Promise<{
  externalId: string; name: string; parentExternalId: string | null;
  path: string; depth: number; leaf: boolean; listingAllowed: boolean;
}[]>;

/// O provedor de cada canal decide de onde vem a árvore. Só o Mercado Livre
/// tem uma; o sebo não tem o conceito.
export function categoryFetcherFor(provider: string, fetcher: typeof fetch = fetch): CategoryFetcher | null {
  if (provider === "MERCADO_LIVRE") {
    return (token) => fetchMercadoLivreCategories(token, undefined, fetcher);
  }
  return null;
}

/**
 * Se o canal tem árvore de categorias a importar.
 *
 * Não é o mesmo que "tem integração": o Sebo On-Line tem integração completa e
 * nenhuma árvore — a categoria dele é o texto livre do produto. Confundir as
 * duas coisas faz a tela oferecer uma importação que nunca vai acontecer.
 *
 * Derivado do próprio despachante, para não haver duas listas de provedores
 * que possam discordar.
 */
export function canalTemArvore(code: string) {
  const provider = providerDoCanal(code);
  return provider !== null && categoryFetcherFor(provider) !== null;
}

/**
 * Importa a árvore de um canal.
 *
 * A troca é feita em transação: apaga o que havia e grava o novo. Sem isso,
 * uma falha no meio deixaria a árvore pela metade, e a tela ofereceria um
 * ramo que não leva a lugar nenhum.
 */
export async function syncMarketplaceCategories(
  db: PrismaClient, marketplaceId: string, buscar: CategoryFetcher, token: string,
) {
  const categorias = await buscar(token);
  const syncedAt = new Date();

  await db.$transaction(async (tx) => {
    await tx.marketplaceCategory.deleteMany({ where: { marketplaceId } });
    for (let i = 0; i < categorias.length; i += LOTE) {
      await tx.marketplaceCategory.createMany({
        data: categorias.slice(i, i + LOTE).map((c) => ({ ...c, marketplaceId, syncedAt })),
      });
    }
  }, { timeout: 120000, maxWait: 15000 });

  return { total: categorias.length, folhas: categorias.filter((c) => c.leaf).length, syncedAt };
}

/**
 * Importa a árvore de um canal se ela estiver ausente ou velha.
 *
 * Usada logo depois da autorização. Nunca lança: a conexão já foi gravada, e
 * uma falha aqui não pode desfazer nem parecer que a autorização falhou.
 */
export async function syncCategoriesIfStale(
  db: PrismaClient, marketplaceId: string, provider: string, accessToken: string,
  fetcher: typeof fetch = fetch, agora = new Date(),
) {
  const buscar = categoryFetcherFor(provider, fetcher);
  if (!buscar) return { estado: "sem-arvore" as const };

  const recente = await db.marketplaceCategory.findFirst({
    where: { marketplaceId, syncedAt: { gt: new Date(agora.getTime() - VALIDADE_MS) } },
    select: { id: true },
  });
  if (recente) return { estado: "em-dia" as const };

  try {
    const resultado = await syncMarketplaceCategories(db, marketplaceId, buscar, accessToken);
    return { estado: "importada" as const, ...resultado };
  } catch {
    // Só o estado; a mensagem do provedor pode carregar detalhe da credencial.
    return { estado: "falhou" as const };
  }
}

/// Importa a árvore de todos os canais conectados que ainda não a têm.
/// É o que o job chama.
export async function syncAllCategories(db: PrismaClient, fetcher: typeof fetch = fetch) {
  const conexoes = await db.marketplaceConnection.findMany({
    where: { status: "ACTIVE", marketplace: { active: true } },
    select: { marketplaceId: true, provider: true, accessToken: true, marketplace: { select: { name: true } } },
  });

  const resultados: { canal: string; estado: string; total?: number }[] = [];
  for (const conexao of conexoes) {
    if (!conexao.accessToken) { resultados.push({ canal: conexao.marketplace.name, estado: "sem-credencial" }); continue; }
    const resultado = await syncCategoriesIfStale(
      db, conexao.marketplaceId, conexao.provider, decryptSecret(conexao.accessToken), fetcher);
    resultados.push({ canal: conexao.marketplace.name, ...resultado });
  }
  return { canais: conexoes.length, resultados };
}

// ---------------------------------------------------------------------------
// Consulta pela tela
// ---------------------------------------------------------------------------

/// Canais que têm árvore importada, com quando foi e quantas categorias.
export async function listCategoryTrees(db: PrismaClient, actor: UserActor) {
  const canais = await db.marketplace.findMany({
    where: { organizationId: actor.organizationId, active: true },
    select: { id: true, name: true, code: true },
    orderBy: { name: "asc" },
  });
  const contagens = await db.marketplaceCategory.groupBy({
    by: ["marketplaceId"],
    where: { marketplaceId: { in: canais.map((c) => c.id) } },
    _count: { _all: true },
    _max: { syncedAt: true },
  });
  return canais.map((canal) => {
    const contagem = contagens.find((c) => c.marketplaceId === canal.id);
    return {
      id: canal.id,
      name: canal.name,
      temArvore: (contagem?._count._all ?? 0) > 0,
      total: contagem?._count._all ?? 0,
      syncedAt: contagem?._max.syncedAt?.toISOString() ?? null,
      // Provedor sem árvore usa a categoria em texto do produto. A tela precisa
      // separar isso de "árvore ainda não importada", que se resolve
      // importando — esta não se resolve nunca.
      suportaArvore: canalTemArvore(canal.code),
    };
  });
}

/// Filhos diretos de um nó, ou as raízes quando `parentExternalId` é nulo.
export async function listCategoryChildren(
  db: PrismaClient, actor: UserActor, marketplaceId: string, parentExternalId: string | null,
) {
  const id = textInput(marketplaceId, "Canal");
  // A organização entra no filtro: id de canal vindo da tela não alcança a
  // árvore de outro tenant.
  const canal = await db.marketplace.findFirst({
    where: { id, organizationId: actor.organizationId }, select: { id: true },
  });
  if (!canal) throw new OrderError("Canal não encontrado.");

  return db.marketplaceCategory.findMany({
    where: { marketplaceId: id, parentExternalId },
    select: { externalId: true, name: true, leaf: true, path: true, listingAllowed: true },
    orderBy: { name: "asc" },
  });
}

/// Busca por texto no caminho completo. Só folhas, porque só elas recebem
/// anúncio — oferecer uma intermediária levaria a um erro na publicação.
export async function searchCategories(
  db: PrismaClient, actor: UserActor, marketplaceId: string, termo: string, limite = 20,
) {
  const id = textInput(marketplaceId, "Canal");
  const busca = textInput(termo, "Busca", 100);
  const canal = await db.marketplace.findFirst({
    where: { id, organizationId: actor.organizationId }, select: { id: true },
  });
  if (!canal) throw new OrderError("Canal não encontrado.");

  return db.marketplaceCategory.findMany({
    where: { marketplaceId: id, leaf: true, listingAllowed: true, path: { contains: busca, mode: "insensitive" } },
    select: { externalId: true, name: true, path: true },
    orderBy: { path: "asc" },
    take: Math.min(Math.max(limite, 1), 50),
  });
}

/**
 * Grava a categoria escolhida para um produto num canal.
 *
 * Cria o anúncio como rascunho se ele ainda não existir: escolher a categoria
 * é declarar a intenção de publicar ali, e é onde a escolha precisa morar para
 * a publicação encontrá-la depois.
 */
export async function setListingCategory(
  db: PrismaClient, actor: UserActor, productId: string, marketplaceId: string,
  categoryExternalId: string | null,
) {
  const produto = textInput(productId, "Produto");
  const canal = textInput(marketplaceId, "Canal");
  const categoria = categoryExternalId === null || categoryExternalId === ""
    ? null : textInput(categoryExternalId, "Categoria", 40);

  return serializable(db, async (tx) => {
    await assertOrgAdmin(tx, actor);
    const alvo = await tx.product.findFirst({
      where: { id: produto, organizationId: actor.organizationId }, select: { id: true, sku: true },
    });
    if (!alvo) throw new OrderError("Produto não encontrado.");
    const marketplace = await tx.marketplace.findFirst({
      where: { id: canal, organizationId: actor.organizationId, active: true },
      select: { id: true, name: true },
    });
    if (!marketplace) throw new OrderError("Canal não encontrado ou inativo.");

    if (categoria) {
      // Só folha permitida para publicação: uma intermediária seria recusada
      // pelo provedor, longe de quem escolheu.
      const existe = await tx.marketplaceCategory.findUnique({
        where: { marketplaceId_externalId: { marketplaceId: canal, externalId: categoria } },
        select: { leaf: true, listingAllowed: true, path: true },
      });
      if (!existe) throw new OrderError("Categoria não encontrada neste canal.");
      if (!existe.leaf) throw new OrderError("Escolha uma subcategoria final, não um agrupamento.");
      if (!existe.listingAllowed) throw new OrderError("Essa categoria não aceita novas publicações.");
    }

    const anterior = await tx.listing.findUnique({
      where: { productId_marketplaceId: { productId: produto, marketplaceId: canal } },
      select: { id: true, status: true, categoryExternalId: true },
    });
    const mudou = (anterior?.categoryExternalId ?? null) !== categoria;

    const listing = await tx.listing.upsert({
      where: { productId_marketplaceId: { productId: produto, marketplaceId: canal } },
      update: { categoryExternalId: categoria },
      // Rascunho: a categoria foi escolhida, a publicação ainda não foi pedida.
      create: { productId: produto, marketplaceId: canal, categoryExternalId: categoria, status: "DRAFT", needsSync: false },
      select: { id: true, status: true },
    });

    // Anúncio já publicado com categoria diferente precisa ir ao provedor de
    // novo. Rascunho não, porque nunca foi; e regravar o mesmo valor também
    // não, senão salvar sem mexer em nada custaria uma chamada ao provedor.
    if (mudou && listing.status === "PUBLISHED") {
      await tx.listing.update({
        where: { id: listing.id }, data: { needsSync: true, availableAt: new Date(), attempts: 0 },
      });
    }

    await tx.auditLog.create({ data: {
      action: "UPDATE", entity: "PRODUCT", entityId: produto,
      organizationId: actor.organizationId, userId: actor.userId,
      details: categoria
        ? "Categoria de " + alvo.sku + " em " + marketplace.name + ": " + categoria + "."
        : "Categoria de " + alvo.sku + " em " + marketplace.name + " removida.",
      newData: { marketplace: marketplace.name, categoria },
    } });
    return { listingId: listing.id, categoryExternalId: categoria };
  });
}
