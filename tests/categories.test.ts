import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { OrderError } from "../lib/domain/order-input";
import { fetchMercadoLivreCategories } from "../lib/integrations/mercadolivre/categories";
import {
  canalTemArvore, listCategoryChildren, listCategoryTrees, searchCategories, setListingCategory,
  syncCategoriesIfStale, syncMarketplaceCategories, VALIDADE_MS,
} from "../lib/services/categories";
import { createProduct } from "../lib/services/products";
import { requestPublication, syncListings } from "../lib/services/listings";

const db = new PrismaClient();

/// Recorte da resposta real do Mercado Livre: o formato é um objeto indexado
/// pelo id, e cada entrada traz a linhagem completa em path_from_root.
const ARVORE = {
  MLB5672: {
    id: "MLB5672", name: "Acessórios para Veículos",
    path_from_root: [{ id: "MLB5672", name: "Acessórios para Veículos" }],
    settings: { listing_allowed: false },
  },
  MLB1747: {
    id: "MLB1747", name: "Aces. de Carros e Caminhonetes",
    path_from_root: [
      { id: "MLB5672", name: "Acessórios para Veículos" },
      { id: "MLB1747", name: "Aces. de Carros e Caminhonetes" },
    ],
  },
  MLB432998: {
    id: "MLB432998", name: "Acabamentos para Racks",
    path_from_root: [
      { id: "MLB5672", name: "Acessórios para Veículos" },
      { id: "MLB1747", name: "Aces. de Carros e Caminhonetes" },
      { id: "MLB432998", name: "Acabamentos para Racks" },
    ],
    settings: { listing_allowed: true },
  },
  MLB1196: {
    id: "MLB1196", name: "Livros",
    path_from_root: [{ id: "MLB1196", name: "Livros" }],
  },
  MLB437616: {
    id: "MLB437616", name: "Livros Físicos",
    path_from_root: [
      { id: "MLB1196", name: "Livros" },
      { id: "MLB437616", name: "Livros Físicos" },
    ],
    settings: { listing_allowed: false },
  },
  MLB437617: {
    id: "MLB437617", name: "Livros Digitais",
    path_from_root: [
      { id: "MLB1196", name: "Livros" },
      { id: "MLB437617", name: "Livros Digitais" },
    ],
    settings: { listing_allowed: true },
  },
};

function fetcherDe(corpo: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(corpo), {
    status, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

test("árvore de categorias do Mercado Livre sem rede", async (t) => {
  await t.test("linhagem vira pai, profundidade e caminho legível", async () => {
    const cats = await fetchMercadoLivreCategories("token", "MLB", fetcherDe(ARVORE));
    const folha = cats.find((c) => c.externalId === "MLB432998")!;
    assert.equal(folha.parentExternalId, "MLB1747");
    assert.equal(folha.depth, 2);
    assert.equal(folha.path, "Acessórios para Veículos > Aces. de Carros e Caminhonetes > Acabamentos para Racks");

    const raiz = cats.find((c) => c.externalId === "MLB5672")!;
    assert.equal(raiz.parentExternalId, null);
    assert.equal(raiz.depth, 0);
  });

  await t.test("folha é quem não é pai de ninguém", async () => {
    const cats = await fetchMercadoLivreCategories("token", "MLB", fetcherDe(ARVORE));
    const porId = new Map(cats.map((c) => [c.externalId, c]));
    assert.equal(porId.get("MLB432998")?.leaf, true);
    assert.equal(porId.get("MLB437616")?.leaf, true);
    // Tem filhos, logo não é folha — mesmo sem a resposta dizer isso.
    assert.equal(porId.get("MLB5672")?.leaf, false);
    assert.equal(porId.get("MLB1747")?.leaf, false);
  });

  await t.test("só o false explícito fecha a categoria", async () => {
    const cats = await fetchMercadoLivreCategories("token", "MLB", fetcherDe(ARVORE));
    const porId = new Map(cats.map((c) => [c.externalId, c]));
    assert.equal(porId.get("MLB432998")?.listingAllowed, true);
    assert.equal(porId.get("MLB437616")?.listingAllowed, false);
    // Sem settings, permitido: ausência não é proibição.
    assert.equal(porId.get("MLB1747")?.listingAllowed, true);
  });

  await t.test("respostas ruins viram erro nomeado, sem vazar corpo", async () => {
    await assert.rejects(fetchMercadoLivreCategories("t", "MLB", fetcherDe({}, 401)),
      (e: Error) => e.message === "ML_UNAUTHORIZED");
    await assert.rejects(fetchMercadoLivreCategories("t", "MLB", fetcherDe({}, 503)),
      (e: Error) => e.message === "ML_UNAVAILABLE");
    await assert.rejects(fetchMercadoLivreCategories("t", "MLB", fetcherDe({})), OrderError);
    await assert.rejects(fetchMercadoLivreCategories("t", "mlb", fetcherDe(ARVORE)), OrderError);
  });
});

test("quem tem árvore de categorias", async (t) => {
  await t.test("ter integração não é ter árvore", () => {
    assert.equal(canalTemArvore("mercado_livre"), true);
    assert.equal(canalTemArvore("mercadolivre"), true);
    // Integração completa, nenhuma árvore: a categoria é o texto do produto.
    assert.equal(canalTemArvore("sebo"), false);
    assert.equal(canalTemArvore("sebo_online"), false);
    assert.equal(canalTemArvore("shopee"), false);
    assert.equal(canalTemArvore("feira-livre"), false);
  });
});

test("categorias por canal em PostgreSQL", async (t) => {
  try {
    const org = await db.organization.create({ data: { name: "Categorias" } });
    const admin = await db.user.create({ data: {
      organizationId: org.id, email: `admin-cat2-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const operador = await db.user.create({ data: {
      organizationId: org.id, email: `op-cat2-${Date.now()}@local.test`,
      name: "Op", passwordHash: "x", role: "OPERATOR",
    } });
    const ator = { userId: admin.id, organizationId: org.id };

    const canalML = await db.marketplace.create({
      data: { organizationId: org.id, code: "mercado_livre", name: "ML das categorias" },
    });
    const canalSebo = await db.marketplace.create({
      data: { organizationId: org.id, code: "sebo", name: "Sebo das categorias" },
    });
    await db.marketplaceConnection.create({ data: {
      marketplaceId: canalML.id, provider: "MERCADO_LIVRE",
      externalAccountId: `conta-cat-${Date.now()}`, accessToken: "cifrado",
    } });

    const buscar = async () => (await fetchMercadoLivreCategories("t", "MLB", fetcherDe(ARVORE)));
    const produto = await createProduct(db, ator, {
      sku: "CATEG-001", title: "Produto categorizado", price: "10.00", stock: 3,
    });

    await t.test("a importação grava a árvore inteira do canal", async () => {
      const resultado = await syncMarketplaceCategories(db, canalML.id, buscar, "token");
      assert.equal(resultado.total, 6);
      assert.equal(resultado.folhas, 3);
      assert.equal(await db.marketplaceCategory.count({ where: { marketplaceId: canalML.id } }), 6);
    });

    await t.test("reimportar substitui em vez de duplicar", async () => {
      await syncMarketplaceCategories(db, canalML.id, buscar, "token");
      assert.equal(await db.marketplaceCategory.count({ where: { marketplaceId: canalML.id } }), 6);
    });

    await t.test("a árvore de um canal não vaza para outro", async () => {
      assert.equal(await db.marketplaceCategory.count({ where: { marketplaceId: canalSebo.id } }), 0);
      const filhos = await listCategoryChildren(db, ator, canalSebo.id, null);
      assert.equal(filhos.length, 0);
    });

    await t.test("descer a árvore devolve um nível de cada vez", async () => {
      const raizes = await listCategoryChildren(db, ator, canalML.id, null);
      assert.deepEqual(raizes.map((r) => r.externalId).sort(), ["MLB1196", "MLB5672"]);
      assert.equal(raizes.every((r) => !r.leaf), true);

      const filhos = await listCategoryChildren(db, ator, canalML.id, "MLB1747");
      assert.deepEqual(filhos.map((f) => f.externalId), ["MLB432998"]);
      assert.equal(filhos[0].leaf, true);
    });

    await t.test("a busca só devolve folha publicável", async () => {
      const achados = await searchCategories(db, ator, canalML.id, "livros");
      // MLB1196 é intermediária e MLB437616 é folha fechada: só a digital entra.
      assert.deepEqual(achados.map((a) => a.externalId), ["MLB437617"]);

      const racks = await searchCategories(db, ator, canalML.id, "racks");
      assert.deepEqual(racks.map((r) => r.externalId), ["MLB432998"]);
      // A busca varre o caminho inteiro, não só o nome da folha.
      assert.equal((await searchCategories(db, ator, canalML.id, "Acessórios para Ve")).length, 1);
    });

    await t.test("escolher categoria cria o anúncio como rascunho", async () => {
      const resultado = await setListingCategory(db, ator, produto.id, canalML.id, "MLB432998");
      assert.equal(resultado.categoryExternalId, "MLB432998");
      const listing = await db.listing.findFirstOrThrow({ where: { productId: produto.id } });
      assert.equal(listing.status, "DRAFT");
      assert.equal(listing.needsSync, false, "rascunho não vai para o trabalhador");
    });

    await t.test("intermediária e fechada são recusadas", async () => {
      await assert.rejects(
        setListingCategory(db, ator, produto.id, canalML.id, "MLB5672"),
        (e: Error) => e instanceof OrderError && /subcategoria final/.test(e.message));
      await assert.rejects(
        setListingCategory(db, ator, produto.id, canalML.id, "MLB437616"),
        (e: Error) => e instanceof OrderError && /não aceita/.test(e.message));
      await assert.rejects(
        setListingCategory(db, ator, produto.id, canalML.id, "MLB999999"),
        (e: Error) => e instanceof OrderError && /não encontrada/.test(e.message));
    });

    await t.test("escolher exige administrador", async () => {
      await assert.rejects(
        setListingCategory(db, { userId: operador.id, organizationId: org.id }, produto.id, canalML.id, "MLB432998"),
        (e: Error) => e instanceof OrderError && /administradores/.test(e.message));
    });

    await t.test("trocar a categoria de um anúncio publicado o marca para ressincronizar", async () => {
      await requestPublication(db, ator, produto.id, [canalML.id]);
      await syncListings(db, async (l) => ({
        externalListingId: "ml-cat", price: l.product.price.toFixed(2), stock: l.product.stock,
      }), 10, org.id);
      const publicado = await db.listing.findFirstOrThrow({
        where: { productId: produto.id, marketplaceId: canalML.id },
      });
      assert.equal(publicado.status, "PUBLISHED");
      assert.equal(publicado.needsSync, false);
      assert.equal(publicado.categoryExternalId, "MLB432998");

      await setListingCategory(db, ator, produto.id, canalML.id, "MLB437617");
      assert.equal(
        (await db.listing.findFirstOrThrow({ where: { id: publicado.id } })).needsSync, true);
    });

    await t.test("regravar a mesma categoria não gera trabalho", async () => {
      const listing = await db.listing.findFirstOrThrow({
        where: { productId: produto.id, marketplaceId: canalML.id },
      });
      await db.listing.update({ where: { id: listing.id }, data: { needsSync: false } });
      await setListingCategory(db, ator, produto.id, canalML.id, "MLB437617");
      assert.equal(
        (await db.listing.findFirstOrThrow({ where: { id: listing.id } })).needsSync, false,
        "salvar o mesmo valor não pode custar uma chamada ao provedor");
    });

    await t.test("remover a categoria deixa o anúncio sem ela", async () => {
      await setListingCategory(db, ator, produto.id, canalML.id, null);
      const listing = await db.listing.findFirstOrThrow({
        where: { productId: produto.id, marketplaceId: canalML.id },
      });
      assert.equal(listing.categoryExternalId, null);
    });

    await t.test("o resumo por canal diz quem tem árvore", async () => {
      const arvores = await listCategoryTrees(db, ator);
      const ml = arvores.find((a) => a.id === canalML.id)!;
      const sebo = arvores.find((a) => a.id === canalSebo.id)!;
      assert.equal(ml.temArvore, true);
      assert.equal(ml.total, 6);
      assert.equal(sebo.temArvore, false);
      // O sebo tem integração completa e nenhuma árvore: a categoria dele é o
      // texto livre do produto. Confundir as duas coisas faz a tela oferecer
      // uma importação que nunca acontece.
      assert.equal(sebo.suportaArvore, false);
      assert.equal(ml.suportaArvore, true);
    });

    await t.test("catálogo de outra organização não alcança a árvore", async () => {
      const outra = await db.organization.create({ data: { name: "Outra das categorias" } });
      const invasor = { userId: admin.id, organizationId: outra.id };
      await assert.rejects(listCategoryChildren(db, invasor, canalML.id, null), OrderError);
      await assert.rejects(searchCategories(db, invasor, canalML.id, "racks"), OrderError);
    });

    await t.test("a importação por validade pula o que está em dia", async () => {
      let chamou = 0;
      const contando = async () => { chamou++; return buscar(); };
      const resultado = await syncCategoriesIfStale(db, canalML.id, "MERCADO_LIVRE", "token",
        fetcherDe(ARVORE));
      assert.equal(resultado.estado, "em-dia");
      assert.equal(chamou, 0, "nem chegou a perguntar ao provedor");
      void contando;
    });

    await t.test("árvore vencida é reimportada", async () => {
      await db.marketplaceCategory.updateMany({
        where: { marketplaceId: canalML.id },
        data: { syncedAt: new Date(Date.now() - VALIDADE_MS - 1000) },
      });
      const resultado = await syncCategoriesIfStale(db, canalML.id, "MERCADO_LIVRE", "token",
        fetcherDe(ARVORE));
      assert.equal(resultado.estado, "importada");
    });

    await t.test("provedor sem árvore não é erro", async () => {
      const resultado = await syncCategoriesIfStale(db, canalSebo.id, "SEBO_ONLINE", "token");
      assert.equal(resultado.estado, "sem-arvore");
    });

    await t.test("falha do provedor não derruba quem chamou", async () => {
      await db.marketplaceCategory.deleteMany({ where: { marketplaceId: canalML.id } });
      const resultado = await syncCategoriesIfStale(db, canalML.id, "MERCADO_LIVRE", "token",
        fetcherDe({}, 500));
      // É o que permite chamá-la depois da autorização sem risco de desfazê-la.
      assert.equal(resultado.estado, "falhou");
      assert.equal(await db.marketplaceCategory.count({ where: { marketplaceId: canalML.id } }), 0);
    });
  } finally { await db.$disconnect(); }
});

test("pedir publicação de um rascunho o coloca na fila", async (t) => {
  const db4 = new PrismaClient();
  try {
    const org = await db4.organization.create({ data: { name: "Rascunho" } });
    const admin = await db4.user.create({ data: {
      organizationId: org.id, email: `admin-rasc-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const ator = { userId: admin.id, organizationId: org.id };
    const canal = await db4.marketplace.create({
      data: { organizationId: org.id, code: "sebo", name: "Sebo do rascunho" },
    });
    await db4.marketplaceConnection.create({ data: {
      marketplaceId: canal.id, provider: "SEBO_ONLINE",
      externalAccountId: `loja-rasc-${Date.now()}`, accessToken: "cifrado",
    } });
    const produto = await createProduct(db4, ator, {
      sku: "RASC-001", title: "Produto rascunho", price: "10.00", stock: 1,
    });

    await t.test("regressão: rascunho pedido vira PUBLISHING e é publicado", async () => {
      // O rascunho nasce da escolha de categoria, sem passar por publicação.
      await db4.listing.create({
        data: { productId: produto.id, marketplaceId: canal.id, status: "DRAFT", needsSync: false },
      });

      await requestPublication(db4, ator, produto.id, [canal.id]);
      const pedido = await db4.listing.findFirstOrThrow({ where: { productId: produto.id } });
      assert.equal(pedido.status, "PUBLISHING", "rascunho precisa entrar na varredura");
      assert.equal(pedido.needsSync, true);

      // A rodada é do sistema inteiro e o banco de teste é compartilhado com as
      // outras suítes, que rodam em paralelo: afirmar sobre a contagem agregada
      // seria instável. O que importa é o destino deste anúncio.
      for (let i = 0; i < 5; i++) {
        const atual = await db4.listing.findFirstOrThrow({ where: { id: pedido.id } });
        if (atual.status === "PUBLISHED") break;
        await syncListings(db4, async (l) => ({
          externalListingId: "sebo-rasc", price: l.product.price.toFixed(2), stock: l.product.stock,
        }), 10, org.id);
      }
      assert.equal(
        (await db4.listing.findFirstOrThrow({ where: { id: pedido.id } })).status, "PUBLISHED");
    });
  } finally { await db4.$disconnect(); }
});
