import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { OrderError } from "../lib/domain/order-input";
import { fetchCategoryAttributes } from "../lib/integrations/mercadolivre/attributes";
import { montarAtributos } from "../lib/integrations/mercadolivre/catalog";
import {
  atributosCanonicos, faltando, lerAtributos, listListingAttributes, setListingAttributes,
} from "../lib/services/listing-attributes";
import { createProduct } from "../lib/services/products";
import { estaEmDia, fingerprintDe, requestPublication, syncListings } from "../lib/services/listings";
import { setListingCategory } from "../lib/services/categories";

const db = new PrismaClient();

/**
 * Recorte fiel da resposta de `/categories/MLB108704/attributes` (camisetas),
 * medida contra a API real. Os quatro tipos que aparecem entre os exigidos
 * estão representados: string com sugestões, string sem, lista fechada e
 * número.
 */
const ATRIBUTOS_ML = [
  { id: "BRAND", name: "Marca", value_type: "string", value_max_length: 255,
    tags: { catalog_required: true, required: true },
    values: [{ id: "1", name: "Nike" }, { id: "2", name: "Adidas" }] },
  { id: "MODEL", name: "Modelo", value_type: "string", value_max_length: 255,
    tags: { catalog_required: true, required: true } },
  { id: "GENDER", name: "Gênero", value_type: "list",
    tags: { required: true },
    values: [{ id: "339665", name: "Feminino" }, { id: "339666", name: "Masculino" }] },
  { id: "SIZE", name: "Tamanho", value_type: "string", value_max_length: 255,
    tags: { required: true }, values: [{ id: "10", name: "M" }, { id: "11", name: "G" }] },
  { id: "ANATEL", name: "Homologação Anatel", value_type: "number", value_max_length: 18,
    tags: { required: true } },
  { id: "GTIN", name: "Código universal", value_type: "string", value_max_length: 255,
    tags: { conditional_required: true } },
  { id: "EMPTY_GTIN_REASON", name: "Motivo", value_type: "list",
    tags: { hidden: true, conditional_required: true },
    values: [{ id: "17055158", name: "O produto é uma peça artesanal" },
             { id: "17055160", name: "O produto não tem código cadastrado" }] },
  // Opcional: não deve aparecer no formulário nem travar a publicação.
  { id: "COLOR", name: "Cor", value_type: "string", tags: {}, values: [{ id: "9", name: "Azul" }] },
];

const fetcherDe = (corpo: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(corpo), {
    status, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

const buscar = async () => fetchCategoryAttributes("MLB108704", fetcherDe(ATRIBUTOS_ML));

test("definição de atributos do Mercado Livre sem rede", async (t) => {
  await t.test("só os exigidos entram, e o derivado fica de fora", async () => {
    const defs = await buscar();
    const ids = defs.map((d) => d.id);
    // COLOR é opcional; EMPTY_GTIN_REASON é consequência, não escolha.
    assert.equal(ids.includes("COLOR"), false);
    assert.equal(ids.includes("EMPTY_GTIN_REASON"), false);
    assert.deepEqual(ids, ["BRAND", "MODEL", "GENDER", "SIZE", "ANATEL", "GTIN"]);
  });

  await t.test("o tipo distingue lista fechada de texto com sugestões", async () => {
    const defs = await buscar();
    const porId = new Map(defs.map((d) => [d.id, d]));
    // `list` é fechada e exige o id do valor.
    assert.equal(porId.get("GENDER")?.tipo, "lista");
    // `string` com valores é SUGESTÃO: o provedor aceita texto livre até 255.
    assert.equal(porId.get("BRAND")?.tipo, "texto");
    assert.equal(porId.get("BRAND")?.valores.length, 2);
    assert.equal(porId.get("BRAND")?.maxLength, 255);
    assert.equal(porId.get("ANATEL")?.tipo, "numero");
  });

  await t.test("required e conditional_required são distinguidos", async () => {
    const defs = await buscar();
    const porId = new Map(defs.map((d) => [d.id, d]));
    assert.equal(porId.get("GENDER")?.obrigatorio, true);
    // Condicional não trava a publicação: o provedor decide.
    assert.equal(porId.get("GTIN")?.obrigatorio, false);
  });

  await t.test("categoria inválida e respostas ruins são recusadas", async () => {
    await assert.rejects(fetchCategoryAttributes("nao-e-categoria", fetcherDe(ATRIBUTOS_ML)), OrderError);
    await assert.rejects(fetchCategoryAttributes("MLB1", fetcherDe({}, 404)),
      (e: Error) => e instanceof OrderError && /não encontrada/.test(e.message));
    await assert.rejects(fetchCategoryAttributes("MLB1", fetcherDe({})), OrderError);
  });

  await t.test("lerAtributos não confia no que está gravado", () => {
    assert.deepEqual(lerAtributos(null), {});
    assert.deepEqual(lerAtributos(["nao", "e", "mapa"]), {});
    assert.deepEqual(lerAtributos({ GENDER: "texto solto" }), {});
    assert.deepEqual(lerAtributos({ GENDER: { valueId: "1" }, VAZIO: { valueName: "" } }),
      { GENDER: { valueId: "1" } });
  });

  await t.test("faltando conta só o exigido sem valor e sem automático", async () => {
    const defs = (await buscar()).map((d) => ({
      ...d, automatico: d.id === "BRAND" ? "Generica" : d.id === "MODEL" ? "SKU-1" : null,
    }));
    assert.deepEqual(faltando(defs, {}), ["Gênero", "Tamanho", "Homologação Anatel"]);
    assert.deepEqual(
      faltando(defs, { GENDER: { valueId: "339665" }, SIZE: { valueName: "M" }, ANATEL: { valueName: "1" } }),
      []);
  });
});

test("atributos do anúncio em PostgreSQL", async (t) => {
  try {
    const org = await db.organization.create({ data: { name: "Atributos" } });
    const admin = await db.user.create({ data: {
      organizationId: org.id, email: `admin-attr-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const operador = await db.user.create({ data: {
      organizationId: org.id, email: `op-attr-${Date.now()}@local.test`,
      name: "Op", passwordHash: "x", role: "OPERATOR",
    } });
    const ator = { userId: admin.id, organizationId: org.id };

    const canalML = await db.marketplace.create({
      data: { organizationId: org.id, code: "mercado_livre", name: "ML dos atributos" },
    });
    const canalSebo = await db.marketplace.create({
      data: { organizationId: org.id, code: "sebo", name: "Sebo dos atributos" },
    });
    for (const [canal, provider] of [[canalML, "MERCADO_LIVRE"], [canalSebo, "SEBO_ONLINE"]] as const) {
      await db.marketplaceConnection.create({ data: {
        marketplaceId: canal.id, provider,
        externalAccountId: `${provider}-attr-${Date.now()}`, accessToken: "cifrado",
      } });
    }
    await db.marketplaceCategory.create({ data: {
      marketplaceId: canalML.id, externalId: "MLB108704", name: "Camisetas",
      parentExternalId: null, leaf: true, path: "Camisetas", depth: 0,
      listingAllowed: true, syncedAt: new Date(),
    } });

    const produto = await createProduct(db, ator, {
      sku: "ATTR-001", title: "Camiseta de teste", brand: "Generica", price: "50.00", stock: 3,
    });

    await t.test("sem categoria escolhida, a tela sabe e não inventa campos", async () => {
      await requestPublication(db, ator, produto.id, [canalML.id]);
      const r = await listListingAttributes(db, ator, produto.id, canalML.id, buscar);
      assert.equal(r.estado, "sem-categoria");
      assert.deepEqual(r.definicoes, []);
    });

    await t.test("canal sem atributos de categoria é reportado como tal", async () => {
      await requestPublication(db, ator, produto.id, [canalSebo.id]);
      const r = await listListingAttributes(db, ator, produto.id, canalSebo.id, buscar);
      assert.equal(r.estado, "sem-atributos");
    });

    await t.test("com categoria, a definição vem do provedor com o automático", async () => {
      await setListingCategory(db, ator, produto.id, canalML.id, "MLB108704");
      const r = await listListingAttributes(db, ator, produto.id, canalML.id, buscar);
      assert.equal(r.estado, "ok");
      const porId = new Map(r.definicoes.map((d) => [d.id, d]));
      // De onde sai o valor quando ninguém preenche.
      assert.equal(porId.get("BRAND")?.automatico, "Generica");
      assert.equal(porId.get("MODEL")?.automatico, "ATTR-001");
      assert.equal(porId.get("GENDER")?.automatico, null);
      assert.deepEqual(r.valores, {});
    });

    await t.test("gravar exige administrador", async () => {
      await assert.rejects(
        setListingAttributes(db, { userId: operador.id, organizationId: org.id },
          produto.id, canalML.id, { GENDER: "339665" }, buscar),
        (e: Error) => e instanceof OrderError && /administradores/.test(e.message));
    });

    await t.test("lista fechada guarda o id; texto guarda o nome", async () => {
      await setListingAttributes(db, ator, produto.id, canalML.id, {
        GENDER: "339665", SIZE: "M", ANATEL: "12345",
      }, buscar);
      const r = await listListingAttributes(db, ator, produto.id, canalML.id, buscar);
      assert.deepEqual(r.valores, {
        GENDER: { valueId: "339665" },
        SIZE: { valueName: "M" },
        ANATEL: { valueName: "12345" },
      });
    });

    await t.test("valor fora da lista fechada é recusado aqui, não na publicação", async () => {
      await assert.rejects(
        setListingAttributes(db, ator, produto.id, canalML.id, { GENDER: "Feminino" }, buscar),
        (e: Error) => e instanceof OrderError && /Valor inválido para Gênero/.test(e.message),
        "o provedor quer o id, não o nome");
    });

    await t.test("texto acima do limite e número inválido são recusados", async () => {
      await assert.rejects(
        setListingAttributes(db, ator, produto.id, canalML.id, { SIZE: "x".repeat(256) }, buscar),
        (e: Error) => e instanceof OrderError && /até 255 caracteres/.test(e.message));
      await assert.rejects(
        setListingAttributes(db, ator, produto.id, canalML.id, { ANATEL: "não é número" }, buscar),
        (e: Error) => e instanceof OrderError && /deve ser um número/.test(e.message));
    });

    await t.test("atributo que a categoria não pede não é gravado", async () => {
      await setListingAttributes(db, ator, produto.id, canalML.id, {
        GENDER: "339665", INVENTADO: "valor", COLOR: "Azul",
      }, buscar);
      const r = await listListingAttributes(db, ator, produto.id, canalML.id, buscar);
      // COLOR é opcional e INVENTADO não existe: os dois viriam como lixo
      // acompanhando o anúncio mesmo depois de trocar de categoria.
      assert.deepEqual(Object.keys(r.valores), ["GENDER"]);
    });

    await t.test("a publicação usa o preenchido e o automático juntos", async () => {
      await setListingAttributes(db, ator, produto.id, canalML.id, {
        GENDER: "339665", SIZE: "G", ANATEL: "999",
      }, buscar);
      const listing = await db.listing.findFirstOrThrow({
        where: { productId: produto.id, marketplaceId: canalML.id },
        include: { product: { include: { images: true } } },
      });
      const atributos = await montarAtributos("t", "MLB108704", listing, fetcherDe(ATRIBUTOS_ML));
      const porId = new Map(atributos.map((a) => [a.id, a]));

      assert.equal(porId.get("GENDER")?.value_id, "339665", "lista fechada vai por id");
      assert.equal(porId.get("SIZE")?.value_name, "G");
      assert.equal(porId.get("ANATEL")?.value_name, "999");
      // Não preenchidos continuam vindo do produto.
      assert.equal(porId.get("BRAND")?.value_name, "Generica");
      assert.equal(porId.get("MODEL")?.value_name, "ATTR-001");
      // Sem GTIN informado, declara-se o vazio com o motivo.
      assert.equal(porId.get("GTIN")?.value_name, null);
      assert.equal(porId.get("EMPTY_GTIN_REASON")?.value_id, "17055160");
    });

    await t.test("GTIN informado dispensa o motivo de vazio", async () => {
      await setListingAttributes(db, ator, produto.id, canalML.id, {
        GENDER: "339665", SIZE: "G", ANATEL: "999", GTIN: "7891234567895",
      }, buscar);
      const listing = await db.listing.findFirstOrThrow({
        where: { productId: produto.id, marketplaceId: canalML.id },
        include: { product: { include: { images: true } } },
      });
      const atributos = await montarAtributos("t", "MLB108704", listing, fetcherDe(ATRIBUTOS_ML));
      const porId = new Map(atributos.map((a) => [a.id, a]));
      assert.equal(porId.get("GTIN")?.value_name, "7891234567895");
      // Mandar o motivo junto de um código válido é contradição.
      assert.equal(porId.has("EMPTY_GTIN_REASON"), false);
    });

    await t.test("exigido sem valor trava a publicação nomeando o campo", async () => {
      const outro = await createProduct(db, ator, {
        sku: "ATTR-002", title: "Outra camiseta", brand: "Generica", price: "10.00", stock: 1,
      });
      await requestPublication(db, ator, outro.id, [canalML.id]);
      await setListingCategory(db, ator, outro.id, canalML.id, "MLB108704");
      const listing = await db.listing.findFirstOrThrow({
        where: { productId: outro.id, marketplaceId: canalML.id },
        include: { product: { include: { images: true } } },
      });
      await assert.rejects(
        montarAtributos("t", "MLB108704", listing, fetcherDe(ATRIBUTOS_ML)),
        (e: Error) => e instanceof OrderError
          && /GENDER/.test(e.message) && /Gênero/.test(e.message)
          && /aba Categoria/.test(e.message));
    });

    await t.test("mudar atributo desatualiza o anúncio", async () => {
      const antes = await db.listing.findFirstOrThrow({
        where: { productId: produto.id, marketplaceId: canalML.id },
        include: { product: { include: { images: true } } },
      });
      const impressaoAntes = fingerprintDe(antes);

      await setListingAttributes(db, ator, produto.id, canalML.id, {
        GENDER: "339666", SIZE: "G", ANATEL: "999", GTIN: "7891234567895",
      }, buscar);

      const depois = await db.listing.findFirstOrThrow({
        where: { productId: produto.id, marketplaceId: canalML.id },
        include: { product: { include: { images: true } } },
      });
      // Regressão: atributo é payload. Ficar fora da impressão foi o que já
      // aconteceu com as imagens e com o título.
      assert.notEqual(fingerprintDe(depois), impressaoAntes, "atributo entra na impressão");
      assert.equal(estaEmDia({ ...depois, publishedFingerprint: impressaoAntes }), false);
    });

    await t.test("anúncio publicado fica pendente ao mudar atributo", async () => {
      const listing = await db.listing.findFirstOrThrow({
        where: { productId: produto.id, marketplaceId: canalML.id },
      });
      await db.listing.update({
        where: { id: listing.id }, data: { status: "PUBLISHED", needsSync: false },
      });
      await setListingAttributes(db, ator, produto.id, canalML.id, {
        GENDER: "339665", SIZE: "M", ANATEL: "111",
      }, buscar);
      assert.equal(
        (await db.listing.findFirstOrThrow({ where: { id: listing.id } })).needsSync, true);
    });

    await t.test("regravar os mesmos valores não gera trabalho", async () => {
      const listing = await db.listing.findFirstOrThrow({
        where: { productId: produto.id, marketplaceId: canalML.id },
      });
      await db.listing.update({ where: { id: listing.id }, data: { needsSync: false } });
      const r = await setListingAttributes(db, ator, produto.id, canalML.id, {
        GENDER: "339665", SIZE: "M", ANATEL: "111",
      }, buscar);
      assert.equal(r.mudou, false);
      assert.equal(
        (await db.listing.findFirstOrThrow({ where: { id: listing.id } })).needsSync, false);
    });

    await t.test("o anúncio de outra organização não é alcançável", async () => {
      const outra = await db.organization.create({ data: { name: "Outra dos atributos" } });
      const invasor = { userId: admin.id, organizationId: outra.id };
      const r = await listListingAttributes(db, invasor, produto.id, canalML.id, buscar);
      assert.equal(r.estado, "sem-anuncio");
      await assert.rejects(
        setListingAttributes(db, invasor, produto.id, canalML.id, { GENDER: "339665" }, buscar),
        OrderError);
    });

    await t.test("o trabalhador entrega os atributos ao adapter", async () => {
      let recebidos: unknown = null;
      await db.listing.updateMany({
        where: { productId: produto.id, marketplaceId: canalML.id },
        data: { status: "PUBLISHING", needsSync: true, availableAt: new Date() },
      });
      await syncListings(db, async (l) => {
        recebidos = lerAtributos(l.attributes);
        return { externalListingId: "MLB1", price: l.product.price.toFixed(2), stock: l.product.stock };
      }, 10, org.id);
      assert.deepEqual(recebidos, {
        GENDER: { valueId: "339665" }, SIZE: { valueName: "M" }, ANATEL: { valueName: "111" },
      });
    });
  } finally { await db.$disconnect(); }
});

test("o que foi enviado ao provedor fica registrado", async (t) => {
  const db2 = new PrismaClient();
  try {
    const org = await db2.organization.create({ data: { name: "Enviados" } });
    const admin = await db2.user.create({ data: {
      organizationId: org.id, email: `admin-env-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const ator = { userId: admin.id, organizationId: org.id };
    const canal = await db2.marketplace.create({
      data: { organizationId: org.id, code: "sebo", name: "Sebo dos enviados" },
    });
    await db2.marketplaceConnection.create({ data: {
      marketplaceId: canal.id, provider: "SEBO_ONLINE",
      externalAccountId: `loja-env-${Date.now()}`, accessToken: "cifrado",
    } });
    const produto = await createProduct(db2, ator, {
      sku: "ENV-001", title: "Produto enviado", price: "10.00", stock: 2,
    });
    await requestPublication(db2, ator, produto.id, [canal.id]);

    await t.test("o adapter reporta os atributos e eles são gravados legíveis", async () => {
      await syncListings(db2, async (l) => ({
        externalListingId: "x1", price: l.product.price.toFixed(2), stock: l.product.stock,
        sentAttributes: [{ id: "BRAND", value_name: "Generica" }, { id: "GTIN", value_name: null }],
      }), 10, org.id);

      const listing = await db2.listing.findFirstOrThrow({ where: { productId: produto.id } });
      // Legível, e não hash: é isto que responde "o que exatamente mandamos?".
      assert.deepEqual(listing.publishedAttributes,
        [{ id: "BRAND", value_name: "Generica" }, { id: "GTIN", value_name: null }]);
    });

    await t.test("operação que não envia atributos preserva o registro anterior", async () => {
      await db2.listing.updateMany({
        where: { productId: produto.id }, data: { needsSync: true, availableAt: new Date() },
      });
      // Uma atualização de preço e estoque não manda atributos. Gravar nulo
      // aqui apagaria a única pista de como o anúncio foi criado.
      await syncListings(db2, async (l) => ({
        externalListingId: "x1", price: l.product.price.toFixed(2), stock: l.product.stock,
      }), 10, org.id);

      const listing = await db2.listing.findFirstOrThrow({ where: { productId: produto.id } });
      assert.deepEqual(listing.publishedAttributes,
        [{ id: "BRAND", value_name: "Generica" }, { id: "GTIN", value_name: null }]);
    });
  } finally { await db2.$disconnect(); }
});

test("forma canônica dos atributos", async (t) => {
  await t.test("regressão: a ordem das chaves não muda a comparação", () => {
    // JSONB devolve as chaves reordenadas. Sem a forma canônica, salvar sem
    // mudar nada parecia mudança, e cada clique em Salvar marcaria o anúncio
    // para republicar.
    const a = { GENDER: { valueId: "1" }, SIZE: { valueName: "M" }, ANATEL: { valueName: "9" } };
    const b = { ANATEL: { valueName: "9" }, GENDER: { valueId: "1" }, SIZE: { valueName: "M" } };
    assert.notEqual(JSON.stringify(a), JSON.stringify(b), "a ingenuidade que falhava");
    assert.deepEqual(atributosCanonicos(a), atributosCanonicos(b));
  });

  await t.test("valor diferente continua sendo diferença", () => {
    assert.notDeepEqual(
      atributosCanonicos({ SIZE: { valueName: "M" } }),
      atributosCanonicos({ SIZE: { valueName: "G" } }));
    // Id e nome não se confundem: o provedor trata os dois campos de forma
    // diferente.
    assert.notDeepEqual(
      atributosCanonicos({ X: { valueId: "1" } }),
      atributosCanonicos({ X: { valueName: "1" } }));
  });
});
