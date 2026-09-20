import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { OrderError } from "../lib/domain/order-input";
import {
  condicaoDoProduto, montarAtributos, prepararFotos, publishMercadoLivreListing,
} from "../lib/integrations/mercadolivre/catalog";
import { ProviderAuthError, ProviderTransientError } from "../lib/integrations/mercadolivre/client";
import type { ListingWithProduct } from "../lib/services/listings";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/// Atributos como a categoria MLB1716 os devolve de verdade: BRAND e MODEL
/// obrigatórios, GTIN e EMPTY_GTIN_REASON condicionais.
const ATRIBUTOS = [
  { id: "BRAND", value_type: "string", tags: { required: true } },
  { id: "MODEL", value_type: "string", tags: { required: true } },
  { id: "GTIN", value_type: "string", tags: { conditional_required: true } },
  {
    id: "EMPTY_GTIN_REASON", value_type: "list", tags: { conditional_required: true },
    values: [
      { id: "17055158", name: "O produto é uma peça artesanal" },
      { id: "17055160", name: "O produto não tem código cadastrado" },
    ],
  },
  { id: "COLOR", value_type: "list", tags: {} },
];

function anuncio(over: Partial<ListingWithProduct> = {}, produtoOver = {}): ListingWithProduct {
  const produto = {
    id: "p1", organizationId: "o1", sku: "CANECA-1", title: "Caneca de teste",
    description: "", category: "", brand: "Generica", condition: "novo",
    price: new Prisma.Decimal("42.50"), currency: "BRL", stock: 4, active: true,
    createdAt: new Date(), updatedAt: new Date(),
    images: [{ id: "i1", productId: "p1", position: 0, url: PNG, createdAt: new Date() }],
    ...produtoOver,
  };
  return {
    id: "l1", productId: "p1", marketplaceId: "m1", status: "PUBLISHING",
    externalListingId: null, publishedPrice: null, publishedStock: null,
    publishedImagesHash: null, categoryExternalId: "MLB1716", publishedCategoryId: null,
    lastPublishedAt: null, needsSync: true, availableAt: new Date(), attempts: 0,
    lastError: null, leaseUntil: null, leaseToken: null,
    createdAt: new Date(), updatedAt: new Date(),
    product: produto,
    ...over,
  } as unknown as ListingWithProduct;
}

/// Dublê que responde por rota e registra o que foi enviado.
function provedor(rotas: Record<string, { status?: number; corpo: unknown }>) {
  const chamadas: { url: string; metodo: string; corpo: unknown }[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const chave = Object.keys(rotas).find((r) => url.includes(r));
    let corpoEnviado: unknown = null;
    if (typeof init.body === "string") corpoEnviado = JSON.parse(init.body);
    else if (init.body instanceof FormData) corpoEnviado = "multipart";
    chamadas.push({ url, metodo: init.method ?? "GET", corpo: corpoEnviado });
    if (!chave) return new Response("{}", { status: 404 });
    const rota = rotas[chave];
    return new Response(JSON.stringify(rota.corpo), {
      status: rota.status ?? 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, chamadas };
}

test("publicação no Mercado Livre sem rede", async (t) => {
  await t.test("condição do catálogo vira a do provedor", () => {
    assert.equal(condicaoDoProduto("novo"), "new");
    assert.equal(condicaoDoProduto("Usado - bom estado"), "used");
    assert.equal(condicaoDoProduto("seminovo"), "used");
    assert.equal(condicaoDoProduto(""), "not_specified");
  });

  await t.test("GTIN vazio vai junto com o motivo, que é o que o provedor aceita", async () => {
    const { fetcher } = provedor({ "/attributes": { corpo: ATRIBUTOS } });
    const atributos = await montarAtributos("t", "MLB1716", anuncio(), fetcher);
    const porId = new Map(atributos.map((a) => [a.id, a]));

    // Texto qualquer no GTIN dá formato inválido; omitir dá campo faltando.
    assert.equal(porId.get("GTIN")?.value_name, null);
    assert.equal(porId.get("EMPTY_GTIN_REASON")?.value_id, "17055160");
    assert.equal(porId.get("BRAND")?.value_name, "Generica");
    // O SKU serve de modelo: curto, estável e único.
    assert.equal(porId.get("MODEL")?.value_name, "CANECA-1");
    // Opcional não entra: só o que a categoria exige.
    assert.equal(porId.has("COLOR"), false);
  });

  await t.test("atributo exigido que o catálogo não tem vira erro nomeado", async () => {
    const exigeVoltagem = [...ATRIBUTOS, { id: "VOLTAGE", value_type: "list", tags: { required: true } }];
    const { fetcher } = provedor({ "/attributes": { corpo: exigeVoltagem } });
    await assert.rejects(
      montarAtributos("t", "MLB1716", anuncio(), fetcher),
      (e: Error) => e instanceof OrderError && /VOLTAGE/.test(e.message) && /Escolha outra categoria/.test(e.message));
  });

  await t.test("marca vazia é recusada com o nome do campo", async () => {
    const { fetcher } = provedor({ "/attributes": { corpo: ATRIBUTOS } });
    await assert.rejects(
      montarAtributos("t", "MLB1716", anuncio({}, { brand: "" }), fetcher),
      (e: Error) => e instanceof OrderError && /marca do produto/.test(e.message));
  });

  await t.test("URL externa o provedor busca; data URI é enviado antes", async () => {
    const { fetcher, chamadas } = provedor({ "/pictures/items/upload": { corpo: { id: "FOTO-1" } } });
    const fotos = await prepararFotos("t", ["https://exemplo.invalid/a.png", PNG], fetcher);

    assert.deepEqual(fotos[0], { source: "https://exemplo.invalid/a.png" });
    assert.deepEqual(fotos[1], { id: "FOTO-1" });
    // Só o data URI gerou envio: a URL externa não passa por upload.
    const uploads = chamadas.filter((c) => c.url.includes("/pictures/items/upload"));
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].corpo, "multipart");
  });

  await t.test("criação manda family_name e NÃO manda title", async () => {
    const { fetcher, chamadas } = provedor({
      "/attributes": { corpo: ATRIBUTOS },
      "/pictures/items/upload": { corpo: { id: "FOTO-1" } },
      "/items": { corpo: { id: "MLB123", price: 42.5, available_quantity: 4 } },
    });
    const resultado = await publishMercadoLivreListing("t", anuncio(), fetcher);
    assert.deepEqual(resultado, { externalListingId: "MLB123", price: "42.50", stock: 4 });

    const criacao = chamadas.find((c) => c.metodo === "POST" && c.url.endsWith("/items"))!;
    const corpo = criacao.corpo as Record<string, unknown>;
    assert.equal(corpo.family_name, "Caneca de teste");
    assert.equal("title" in corpo, false, "title é recusado quando há family_name");
    assert.equal(corpo.category_id, "MLB1716");
    assert.equal(corpo.condition, "new");
    assert.equal(corpo.currency_id, "BRL");
    assert.equal(corpo.available_quantity, 4);
    assert.deepEqual(corpo.pictures, [{ id: "FOTO-1" }]);
    // Retirada em mãos contorna a exigência de ME2.
    assert.deepEqual(corpo.shipping, { mode: "not_specified", local_pick_up: true, free_shipping: false });
  });

  await t.test("atualização não remanda a categoria", async () => {
    const { fetcher, chamadas } = provedor({
      "/items/MLB123": { corpo: { id: "MLB123", price: 39.9, available_quantity: 2 } },
    });
    const resultado = await publishMercadoLivreListing(
      "t", anuncio({ externalListingId: "MLB123" }), fetcher);
    assert.deepEqual(resultado, { externalListingId: "MLB123", price: "39.90", stock: 2 });

    const put = chamadas.find((c) => c.metodo === "PUT")!;
    const corpo = put.corpo as Record<string, unknown>;
    // O provedor restringe trocar categoria depois; mandá-la faria o anúncio
    // inteiro ser recusado por causa de um campo que nem mudou.
    assert.equal("category_id" in corpo, false);
    assert.equal("family_name" in corpo, false);
    assert.deepEqual(Object.keys(corpo).sort(), ["available_quantity", "price"]);
    // Atualizar não recompra atributos nem reenvia imagem.
    assert.equal(chamadas.some((c) => c.url.includes("/attributes")), false);
    assert.equal(chamadas.some((c) => c.url.includes("/pictures")), false);
  });

  await t.test("o preço e o estoque gravados são os que o provedor confirmou", async () => {
    const { fetcher } = provedor({
      "/items/MLB123": { corpo: { id: "MLB123", price: 40, available_quantity: 1 } },
    });
    const resultado = await publishMercadoLivreListing(
      "t", anuncio({ externalListingId: "MLB123" }), fetcher);
    // Pedimos 42,50 e estoque 4; o provedor disse 40,00 e 1. Vale o dele.
    assert.equal(resultado.price, "40.00");
    assert.equal(resultado.stock, 1);
  });

  await t.test("sem categoria e sem imagem, a recusa é nossa e explica o que fazer", async () => {
    const { fetcher } = provedor({});
    await assert.rejects(
      publishMercadoLivreListing("t", anuncio({ categoryExternalId: null }), fetcher),
      (e: Error) => e instanceof OrderError && /aba Categoria/.test(e.message));
    await assert.rejects(
      publishMercadoLivreListing("t", anuncio({}, { images: [] }), fetcher),
      (e: Error) => e instanceof OrderError && /ao menos uma imagem/.test(e.message));
  });

  await t.test("a causa do provedor chega a quem cadastrou", async () => {
    const { fetcher } = provedor({
      "/attributes": { corpo: ATRIBUTOS },
      "/pictures/items/upload": { corpo: { id: "FOTO-1" } },
      "/items": {
        status: 400,
        corpo: { cause: [{ code: "item.attribute.missing", message: "The attributes [GTIN] are required" }] },
      },
    });
    await assert.rejects(
      publishMercadoLivreListing("t", anuncio(), fetcher),
      (e: Error) => e instanceof OrderError && /GTIN/.test(e.message),
      "sem a causa do provedor, o operador não sabe o que corrigir");
  });

  await t.test("credencial e indisponibilidade são classificadas, não confundidas", async () => {
    const auth = provedor({ "/attributes": { status: 401, corpo: {} } });
    await assert.rejects(publishMercadoLivreListing("t", anuncio(), auth.fetcher),
      (e: Error) => e instanceof ProviderAuthError);

    const fora = provedor({ "/attributes": { status: 503, corpo: {} } });
    await assert.rejects(publishMercadoLivreListing("t", anuncio(), fora.fetcher),
      (e: Error) => e instanceof ProviderTransientError);
  });

  await t.test("resposta sem preço ou identificador é recusada", async () => {
    const { fetcher } = provedor({
      "/attributes": { corpo: ATRIBUTOS },
      "/pictures/items/upload": { corpo: { id: "FOTO-1" } },
      "/items": { corpo: { id: "MLB123" } },
    });
    await assert.rejects(publishMercadoLivreListing("t", anuncio(), fetcher),
      (e: Error) => e instanceof OrderError && /sem preço ou estoque/.test(e.message));
  });
});
