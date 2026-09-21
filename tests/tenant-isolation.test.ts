import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { OrderError } from "../lib/domain/order-input";
import { fetchCategoryAttributes } from "../lib/integrations/mercadolivre/attributes";
import {
  listCategoryChildren, listCategoryTrees, searchCategories, setListingCategory,
  syncMarketplaceCategories,
} from "../lib/services/categories";
import { listListingAttributes, setListingAttributes } from "../lib/services/listing-attributes";
import { requestPublication, syncListings } from "../lib/services/listings";
import { createProduct, listProducts, setProductStock, updateProduct } from "../lib/services/products";
import { changeManualStatus, createManualOrder } from "../lib/services/sales";

/**
 * Isolamento entre organizações, porta por porta.
 *
 * Os testes de acesso já cobrem usuário e organização. Este cobre o DADO: para
 * cada função de serviço que a tela chama com um identificador, o ator de uma
 * organização tenta alcançar o registro de outra — produto, canal, anúncio,
 * árvore de categorias, atributos, venda.
 *
 * É uma prova executável, e não uma leitura: o padrão do código é "valide o id
 * dentro da organização, depois opere por chave primária", e uma varredura das
 * consultas mostra o segundo passo sem filtro em muitos lugares. O que garante
 * a propriedade é o primeiro passo, e é ele que este arquivo exercita.
 *
 * Um teste que passa aqui não prova ausência de vazamento em código futuro —
 * prova que hoje toda porta conhecida está fechada.
 */

/// O endpoint do provedor devolve um MAPA de categorias, não uma lista -- é o
/// formato real, e o mesmo que a suíte de categorias usa.
const ARVORE = {
  MLB1000: {
    id: "MLB1000", name: "Raiz",
    path_from_root: [{ id: "MLB1000", name: "Raiz" }],
    settings: { listing_allowed: false },
  },
  MLB1001: {
    id: "MLB1001", name: "Folha",
    path_from_root: [{ id: "MLB1000", name: "Raiz" }, { id: "MLB1001", name: "Folha" }],
    settings: { listing_allowed: true },
  },
};

const ATRIBUTOS = [
  { id: "BRAND", name: "Marca", value_type: "string", tags: { required: true } },
  { id: "MODEL", name: "Modelo", value_type: "string", tags: { required: true } },
];

const fetcherDe = (corpo: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(corpo), {
    status: 200, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

test("uma organização não alcança o dado da outra", async (t) => {
  const db = new PrismaClient();
  try {
    // Duas organizações completas, cada uma com admin, canal e produto.
    const montar = async (nome: string, codigo: string) => {
      const org = await db.organization.create({ data: { name: nome } });
      const admin = await db.user.create({ data: {
        organizationId: org.id, email: `admin-${nome}-${Date.now()}@local.test`,
        name: "Admin", passwordHash: "x", role: "ADMIN",
      } });
      const ator = { userId: admin.id, organizationId: org.id };
      const canal = await db.marketplace.create({
        data: { organizationId: org.id, code: codigo, name: `Canal ${nome}` },
      });
      await db.marketplaceConnection.create({ data: {
        marketplaceId: canal.id, provider: "MERCADO_LIVRE",
        externalAccountId: `conta-${nome}-${Date.now()}`, accessToken: "cifrado",
      } });
      const produto = await createProduct(db, ator, {
        sku: `SKU-${nome}`, title: `Produto da ${nome}`, price: "50.00", stock: 7,
        brand: "Marca", images: ["https://exemplo.invalid/a.png"],
      });
      return { org, ator, canal, produto };
    };

    const alfa = await montar("Alfa", "mercado_livre");
    const beta = await montar("Beta", "mercado_livre");

    // A árvore de categorias da Beta existe, para as consultas terem o que achar.
    await syncMarketplaceCategories(
      db, beta.canal.id,
      async () => (await import("../lib/integrations/mercadolivre/categories"))
        .fetchMercadoLivreCategories("t", "MLB", fetcherDe(ARVORE)),
      "token",
    );

    await t.test("catálogo: listar mostra só o próprio", async () => {
      const lista = await listProducts(db, alfa.ator);
      assert.equal(lista.some((p) => p.id === alfa.produto.id), true);
      assert.equal(lista.some((p) => p.id === beta.produto.id), false);
    });

    await t.test("catálogo: editar e mexer no estoque do alheio é recusado", async () => {
      await assert.rejects(
        updateProduct(db, alfa.ator, beta.produto.id, {
          sku: "SKU-Beta", title: "Sequestrado", price: "1.00", stock: 0,
        }),
        (e: Error) => e instanceof OrderError && /não encontrado/.test(e.message));
      await assert.rejects(
        setProductStock(db, alfa.ator, beta.produto.id, 999),
        (e: Error) => e instanceof OrderError && /não encontrado/.test(e.message));

      // E o registro da Beta continua intacto.
      const depois = await db.product.findUniqueOrThrow({ where: { id: beta.produto.id } });
      assert.equal(depois.title, "Produto da Beta");
      assert.equal(depois.stock, 7);
    });

    await t.test("publicação: nem o produto nem o canal do outro servem", async () => {
      // Produto alheio, canal próprio.
      await assert.rejects(
        requestPublication(db, alfa.ator, beta.produto.id, [alfa.canal.id]),
        (e: Error) => e instanceof OrderError && /não encontrado/.test(e.message));
      // Produto próprio, canal alheio.
      await assert.rejects(
        requestPublication(db, alfa.ator, alfa.produto.id, [beta.canal.id]),
        (e: Error) => e instanceof OrderError && /não encontrado|inativo/.test(e.message));
      assert.equal(await db.listing.count({ where: { productId: beta.produto.id } }), 0);
    });

    await t.test("categoria: a árvore e a escolha do outro não são alcançáveis", async () => {
      await assert.rejects(
        listCategoryChildren(db, alfa.ator, beta.canal.id, null),
        (e: Error) => e instanceof OrderError && /não encontrado/.test(e.message));
      await assert.rejects(
        searchCategories(db, alfa.ator, beta.canal.id, "folha"),
        (e: Error) => e instanceof OrderError && /não encontrado/.test(e.message));
      await assert.rejects(
        setListingCategory(db, alfa.ator, beta.produto.id, beta.canal.id, "MLB1001"),
        (e: Error) => e instanceof OrderError && /não encontrado/.test(e.message));

      // A listagem de canais para escolher categoria também é só do próprio.
      const canais = await listCategoryTrees(db, alfa.ator);
      assert.equal(canais.some((c) => c.id === beta.canal.id), false);
    });

    await t.test("atributos: anúncio do outro é invisível, e gravar é recusado", async () => {
      const buscar = async () => fetchCategoryAttributes("MLB1001", fetcherDe(ATRIBUTOS));
      // Dá o anúncio da Beta uma categoria, para haver o que alcançar.
      await setListingCategory(db, beta.ator, beta.produto.id, beta.canal.id, "MLB1001");

      const tela = await listListingAttributes(
        db, alfa.ator, beta.produto.id, beta.canal.id, buscar);
      // "sem-anuncio" e não erro: para o ator da Alfa, aquele anúncio não existe.
      assert.equal(tela.estado, "sem-anuncio");
      await assert.rejects(
        setListingAttributes(db, alfa.ator, beta.produto.id, beta.canal.id, { BRAND: "x" }, buscar),
        (e: Error) => e instanceof OrderError);
    });

    await t.test("venda: criar no canal do outro e mudar a venda do outro é recusado", async () => {
      await assert.rejects(
        createManualOrder(db, alfa.ator, {
          marketplaceId: beta.canal.id, externalOrderId: `X-${Date.now()}`,
          soldAt: new Date().toISOString(), currency: "BRL", gross: "10.00",
          shipping: "0.00", discount: "0.00", fees: "0.00",
          items: [{ title: "Item", quantity: 1, unitPrice: "10.00" }],
        }),
        (e: Error) => e instanceof OrderError);

      const venda = await createManualOrder(db, beta.ator, {
        marketplaceId: beta.canal.id, externalOrderId: `B-${Date.now()}`,
        soldAt: new Date().toISOString(), currency: "BRL", gross: "10.00",
        shipping: "0.00", discount: "0.00", fees: "0.00",
        items: [{ title: "Item", quantity: 1, unitPrice: "10.00" }],
      });
      await assert.rejects(
        changeManualStatus(db, alfa.ator, venda.id, "CANCELLED", venda.statusVersion),
        (e: Error) => e instanceof OrderError);
      assert.equal(
        (await db.sale.findUniqueOrThrow({ where: { id: venda.id } })).status, "CREATED");
    });

    await t.test("o trabalhador de publicação respeita a organização pedida", async () => {
      // Os dois com anúncio pendente; a rodada é da Alfa.
      await setListingCategory(db, alfa.ator, alfa.produto.id, alfa.canal.id, null);
      await requestPublication(db, alfa.ator, alfa.produto.id, [alfa.canal.id]);
      await requestPublication(db, beta.ator, beta.produto.id, [beta.canal.id]);

      const publicados: string[] = [];
      await syncListings(db, async (l) => {
        publicados.push(l.product.organizationId);
        return {
          externalListingId: `ext-${l.id}`, price: l.product.price.toFixed(2),
          stock: l.product.stock,
        };
      }, 10, alfa.org.id);

      // Sem o filtro por organização, o lote de um tenant publicava anúncio de
      // outro -- e era o defeito que a coluna de organização no where corrigiu.
      assert.deepEqual([...new Set(publicados)], [alfa.org.id]);
      assert.equal(
        (await db.listing.findFirstOrThrow({ where: { productId: beta.produto.id } })).needsSync,
        true, "o anúncio da Beta continua esperando a rodada dela");
    });
  } finally { await db.$disconnect(); }
});
