import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { OrderError } from "../lib/domain/order-input";
import { MAX_IMAGE_BYTES, MAX_IMAGENS, parseProduct, tipoDeImagemAceito } from "../lib/domain/product-input";
import {
  appendProductImage, createProduct, listProducts, setProductStock, updateProduct,
} from "../lib/services/products";
import {
  estaEmDia, ListingPublisher, MAX_SYNC_ATTEMPTS, PartialPublishError, pushAposVenda,
  requestPublication, syncListings,
} from "../lib/services/listings";
import { applyIntegratedOrder } from "../lib/services/sales";
import { parseIntegratedOrder } from "../lib/domain/order-input";
import { seboProductPayload } from "../lib/integrations/sebo/catalog";
import { serializable } from "../lib/services/transactions";
import { getProductStats } from "../app/(protected)/dashboard/product-stats";

const db = new PrismaClient();

const produtoBase = {
  sku: "cat-001", title: "Caneca de teste", description: "Uma caneca",
  category: "Casa", brand: "Generico", condition: "novo",
  images: ["https://exemplo.invalid/caneca.png"],
  price: "49.90", stock: 10,
};

test("validação do produto sem banco", async (t) => {
  await t.test("SKU normaliza para maiúsculas e recusa caractere exótico", () => {
    assert.equal(parseProduct(produtoBase).sku, "CAT-001");
    assert.throws(() => parseProduct({ ...produtoBase, sku: "cat 001" }), OrderError);
    assert.throws(() => parseProduct({ ...produtoBase, sku: "-começa-com-hifen" }), OrderError);
  });

  await t.test("preço precisa ser positivo com duas casas", () => {
    assert.equal(parseProduct({ ...produtoBase, price: 49.9 }).price.toFixed(2), "49.90");
    assert.throws(() => parseProduct({ ...produtoBase, price: "0" }), OrderError);
    assert.throws(() => parseProduct({ ...produtoBase, price: "-1.00" }), OrderError);
    assert.throws(() => parseProduct({ ...produtoBase, price: "1.005" }), OrderError);
  });

  await t.test("estoque aceita zero e recusa negativo ou fracionário", () => {
    assert.equal(parseProduct({ ...produtoBase, stock: 0 }).stock, 0);
    assert.equal(parseProduct({ ...produtoBase, stock: "7" }).stock, 7);
    assert.throws(() => parseProduct({ ...produtoBase, stock: -1 }), OrderError);
    assert.throws(() => parseProduct({ ...produtoBase, stock: 1.5 }), OrderError);
  });

  await t.test("título respeita o limite do provedor mais restrito", () => {
    assert.throws(() => parseProduct({ ...produtoBase, title: "x".repeat(61) }), OrderError);
    assert.equal(parseProduct({ ...produtoBase, title: "x".repeat(60) }).title.length, 60);
  });

  await t.test("imagem precisa ser https, porque o provedor busca pelo servidor dele", () => {
    assert.deepEqual(parseProduct({ ...produtoBase, images: [] }).images, []);
    assert.throws(() => parseProduct({ ...produtoBase, images: ["http://x.invalid/a.png"] }), OrderError);
    assert.throws(() => parseProduct({ ...produtoBase, images: ["nao-e-url"] }), OrderError);
  });
});

test("catálogo e publicação em PostgreSQL", async (t) => {
  try {
    const org = await db.organization.create({ data: { name: "Catálogo" } });
    const admin = await db.user.create({ data: {
      organizationId: org.id, email: `admin-cat-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const operador = await db.user.create({ data: {
      organizationId: org.id, email: `op-cat-${Date.now()}@local.test`,
      name: "Operador", passwordHash: "x", role: "OPERATOR",
    } });
    const ator = { userId: admin.id, organizationId: org.id };

    const canal = await db.marketplace.create({
      data: { organizationId: org.id, code: "sebo", name: "Sebo do catálogo" },
    });
    await db.marketplaceConnection.create({ data: {
      marketplaceId: canal.id, provider: "SEBO_ONLINE",
      externalAccountId: `loja-cat-${Date.now()}`, accessToken: "cifrado",
    } });

    let produtoId = "";

    await t.test("criar exige administrador", async () => {
      await assert.rejects(
        createProduct(db, { userId: operador.id, organizationId: org.id }, produtoBase),
        (erro: Error) => erro instanceof OrderError && /administradores/.test(erro.message),
      );
    });

    await t.test("produto criado fica auditado e o SKU é único na organização", async () => {
      const criado = await createProduct(db, ator, produtoBase);
      produtoId = criado.id;
      assert.equal(criado.sku, "CAT-001");

      const auditoria = await db.auditLog.findFirst({
        where: { entity: "PRODUCT", entityId: criado.id, action: "CREATE" },
      });
      assert(auditoria);

      // Mesmo SKU em caixa diferente é o mesmo produto.
      await assert.rejects(
        createProduct(db, ator, { ...produtoBase, sku: "CAT-001" }), OrderError);
    });

    await t.test("publicar exige canal conectado e produto ativo", async () => {
      const semConexao = await db.marketplace.create({
        data: { organizationId: org.id, code: "shopee", name: "Shopee sem conexão" },
      });
      await assert.rejects(
        requestPublication(db, ator, produtoId, [semConexao.id]),
        (erro: Error) => erro instanceof OrderError && /não está conectado/.test(erro.message),
      );

      const semProvedor = await db.marketplace.create({
        data: { organizationId: org.id, code: "feira-livre", name: "Feira" },
      });
      await assert.rejects(
        requestPublication(db, ator, produtoId, [semProvedor.id]),
        (erro: Error) => erro instanceof OrderError && /não tem integração/.test(erro.message),
      );
    });

    await t.test("pedir publicação cria o anúncio pendente", async () => {
      const pedidos = await requestPublication(db, ator, produtoId, [canal.id]);
      assert.equal(pedidos.length, 1);
      const listing = await db.listing.findFirstOrThrow({ where: { productId: produtoId } });
      assert.equal(listing.status, "PUBLISHING");
      assert.equal(listing.needsSync, true);
      assert.equal(listing.externalListingId, null);
    });

    await t.test("pedir de novo não cria um segundo anúncio no mesmo canal", async () => {
      await requestPublication(db, ator, produtoId, [canal.id]);
      assert.equal(await db.listing.count({ where: { productId: produtoId } }), 1);
    });

    await t.test("o trabalhador publica e registra o que o provedor confirmou", async () => {
      // O provedor devolve um preço diferente do pedido: é o dele que vale.
      const publicador: ListingPublisher = async (listing) => {
        assert.equal(listing.product.sku, "CAT-001");
        return { externalListingId: "sebo-77", price: "49.90", stock: listing.product.stock };
      };
      const resultado = await syncListings(db, publicador, 10, org.id);
      assert.equal(resultado.publicados, 1);
      assert.equal(resultado.falhas, 0);

      const listing = await db.listing.findFirstOrThrow({ where: { productId: produtoId } });
      assert.equal(listing.status, "PUBLISHED");
      assert.equal(listing.externalListingId, "sebo-77");
      assert.equal(listing.publishedStock, 10);
      assert.equal(listing.publishedPrice?.toFixed(2), "49.90");
      assert.equal(listing.needsSync, false);
      assert.equal(listing.attempts, 0);
    });

    await t.test("rodar de novo sem mudança não chama o provedor", async () => {
      let chamou = false;
      const publicador: ListingPublisher = async () => { chamou = true; throw new Error("não deveria"); };
      const resultado = await syncListings(db, publicador, 10, org.id);
      assert.equal(chamou, false);
      assert.equal(resultado.publicados, 0);
      assert.equal(resultado.atualizados, 0);
    });

    await t.test("mudar o preço torna o anúncio pendente e manda o valor absoluto", async () => {
      await updateProduct(db, ator, produtoId, { ...produtoBase, price: "59.90" });
      const pendente = await db.listing.findFirstOrThrow({ where: { productId: produtoId } });
      assert.equal(pendente.needsSync, true);
      assert.equal(pendente.status, "PUBLISHED", "continua publicado enquanto ressincroniza");

      let enviado = "";
      await syncListings(db, async (listing) => {
        enviado = listing.product.price.toFixed(2);
        return { externalListingId: "sebo-77", price: enviado, stock: listing.product.stock };
      }, 10, org.id);
      assert.equal(enviado, "59.90");
      const listing = await db.listing.findFirstOrThrow({ where: { productId: produtoId } });
      assert.equal(listing.publishedPrice?.toFixed(2), "59.90");
      assert.equal(listing.needsSync, false);
    });

    await t.test("mudar só campo interno não gera ressincronização", async () => {
      // A descrição viaja para o provedor; o SKU não muda nada lá fora, mas é
      // a mesma chamada: o que importa é que campo igual não marque pendência.
      await updateProduct(db, ator, produtoId, { ...produtoBase, price: "59.90" });
      const listing = await db.listing.findFirstOrThrow({ where: { productId: produtoId } });
      assert.equal(listing.needsSync, false);
    });

    await t.test("três mudanças seguidas custam uma sincronização só", async () => {
      for (const preco of ["61.00", "62.00", "63.00"]) {
        await updateProduct(db, ator, produtoId, { ...produtoBase, price: preco });
      }
      let chamadas = 0;
      await syncListings(db, async (listing) => {
        chamadas++;
        return { externalListingId: "sebo-77", price: listing.product.price.toFixed(2), stock: listing.product.stock };
      }, 10, org.id);
      assert.equal(chamadas, 1, "estado desejado colapsa as mudanças");
      const listing = await db.listing.findFirstOrThrow({ where: { productId: produtoId } });
      assert.equal(listing.publishedPrice?.toFixed(2), "63.00");
    });

    await t.test("falha transitória volta para a fila com backoff", async () => {
      await setProductStock(db, ator, produtoId, 4);
      const resultado = await syncListings(db, async () => { throw new Error("rede caiu"); }, 10, org.id);
      assert.equal(resultado.falhas, 1);

      const listing = await db.listing.findFirstOrThrow({ where: { productId: produtoId } });
      assert.equal(listing.status, "PUBLISHED", "erro transitório não desiste do anúncio");
      assert.equal(listing.needsSync, true);
      assert.equal(listing.attempts, 1);
      assert.equal(listing.lastError, "PUBLICACAO_FALHOU", "mensagem do provedor não é registrada");
      assert(listing.availableAt > new Date(), "espera antes de tentar de novo");
    });

    await t.test("erro de domínio desiste na hora, sem queimar tentativas", async () => {
      await db.listing.updateMany({
        where: { productId: produtoId }, data: { availableAt: new Date(), attempts: 0 },
      });
      const resultado = await syncListings(db, async () => {
        throw new OrderError("O canal não está conectado. Autorize a conexão.");
      }, 10, org.id);
      assert.equal(resultado.falhas, 1);
      const listing = await db.listing.findFirstOrThrow({ where: { productId: produtoId } });
      assert.equal(listing.status, "FAILED");
      assert.equal(listing.needsSync, false, "parou de ser tentado");
      assert.equal(listing.lastError, "O canal não está conectado. Autorize a conexão.");
    });

    await t.test("pedir publicação de novo ressuscita um anúncio que desistiu", async () => {
      await requestPublication(db, ator, produtoId, [canal.id]);
      const listing = await db.listing.findFirstOrThrow({ where: { productId: produtoId } });
      assert.equal(listing.status, "PUBLISHING");
      assert.equal(listing.needsSync, true);
      assert.equal(listing.lastError, null);

      await syncListings(db, async (l) => ({
        externalListingId: "sebo-77", price: l.product.price.toFixed(2), stock: l.product.stock,
      }), 10, org.id);
      assert.equal(
        (await db.listing.findFirstOrThrow({ where: { productId: produtoId } })).status, "PUBLISHED");
    });

    await t.test("teto de tentativas faz o anúncio desistir", async () => {
      const outro = await createProduct(db, ator, { ...produtoBase, sku: "CAT-TETO" });
      await requestPublication(db, ator, outro.id, [canal.id]);
      for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
        await db.listing.updateMany({ where: { productId: outro.id }, data: { availableAt: new Date() } });
        await syncListings(db, async () => { throw new Error("sempre falha"); }, 10, org.id);
      }
      const listing = await db.listing.findFirstOrThrow({ where: { productId: outro.id } });
      assert.equal(listing.status, "FAILED");
      assert.equal(listing.needsSync, false);
      assert(listing.attempts >= MAX_SYNC_ATTEMPTS);
    });

    await t.test("estaEmDia compara a impressão do que foi enviado", async () => {
      const listing = await db.listing.findFirstOrThrow({
        where: { productId: produtoId },
        include: { product: { include: { images: { orderBy: { position: "asc" } } } } },
      });
      assert.equal(estaEmDia(listing), true);
      assert.equal(estaEmDia({ ...listing, status: "PUBLISHING" }), false);

      // Regressão: trocar SÓ o título precisa desatualizar o anúncio. Antes, a
      // comparação olhava preço, estoque, imagens e categoria -- e o título
      // mudado nunca chegava ao canal.
      assert.equal(
        estaEmDia({ ...listing, product: { ...listing.product, title: "Outro nome" } }), false,
        "título mudado é mudança publicável");
      for (const [campo, valor] of [
        ["description", "outra descrição"], ["brand", "Outra marca"],
        ["condition", "usado"], ["category", "Outra categoria"], ["active", false],
      ] as const) {
        assert.equal(
          estaEmDia({ ...listing, product: { ...listing.product, [campo]: valor } }), false,
          `${campo} mudado é mudança publicável`);
      }

      // E o que o provedor confirmou não decide trabalho: se ele arredondar o
      // preço, comparar com a resposta dele reenviaria a cada rodada.
      assert.equal(estaEmDia({ ...listing, publishedStock: 999, publishedPrice: null }), true);
    });

    await t.test("venda que chega baixa o estoque e marca os anúncios", async () => {
      const antes = await db.product.findUniqueOrThrow({ where: { id: produtoId } });
      const evento = await db.integrationEvent.create({ data: {
        marketplaceId: canal.id, externalEventId: `cat-venda-${Date.now()}`,
        externalOrderId: "pedido-cat-1", payload: {},
      } });

      await serializable(db, async (tx) => applyIntegratedOrder(tx, {
        marketplaceId: canal.id, organizationId: org.id,
        eventId: evento.id, externalEventId: evento.externalEventId,
      }, parseIntegratedOrder({
        externalOrderId: "pedido-cat-1", status: "PAID", externalStatus: "PAID",
        externalUpdatedAt: "2026-09-19T10:00:00Z", soldAt: "2026-09-19",
        currency: "BRL", gross: "63.00", shipping: "0.00", discount: "0.00", fees: "0.00",
        items: [{ title: "Caneca", sku: "CAT-001", quantity: 2, unitPrice: "31.50" }],
      })));

      const depois = await db.product.findUniqueOrThrow({ where: { id: produtoId } });
      assert.equal(depois.stock, antes.stock - 2);
      const listing = await db.listing.findFirstOrThrow({ where: { productId: produtoId } });
      assert.equal(listing.needsSync, true, "os canais precisam saber do novo estoque");
    });

    await t.test("cancelar a venda devolve ao estoque", async () => {
      const antes = await db.product.findUniqueOrThrow({ where: { id: produtoId } });
      const evento = await db.integrationEvent.create({ data: {
        marketplaceId: canal.id, externalEventId: `cat-cancel-${Date.now()}`,
        externalOrderId: "pedido-cat-1", payload: {},
      } });
      await serializable(db, async (tx) => applyIntegratedOrder(tx, {
        marketplaceId: canal.id, organizationId: org.id,
        eventId: evento.id, externalEventId: evento.externalEventId,
      }, parseIntegratedOrder({
        externalOrderId: "pedido-cat-1", status: "CANCELLED", externalStatus: "CANCELLED",
        externalUpdatedAt: "2026-09-19T11:00:00Z", soldAt: "2026-09-19",
        currency: "BRL", gross: "63.00", shipping: "0.00", discount: "0.00", fees: "0.00",
        items: [{ title: "Caneca", sku: "CAT-001", quantity: 2, unitPrice: "31.50" }],
      })));
      const depois = await db.product.findUniqueOrThrow({ where: { id: produtoId } });
      assert.equal(depois.stock, antes.stock + 2);
    });

    await t.test("item vendido fora do catálogo não quebra a gravação", async () => {
      const evento = await db.integrationEvent.create({ data: {
        marketplaceId: canal.id, externalEventId: `cat-sem-sku-${Date.now()}`,
        externalOrderId: "pedido-cat-2", payload: {},
      } });
      await serializable(db, async (tx) => applyIntegratedOrder(tx, {
        marketplaceId: canal.id, organizationId: org.id,
        eventId: evento.id, externalEventId: evento.externalEventId,
      }, parseIntegratedOrder({
        externalOrderId: "pedido-cat-2", status: "PAID", externalStatus: "PAID",
        externalUpdatedAt: "2026-09-19T12:00:00Z", soldAt: "2026-09-19",
        currency: "BRL", gross: "10.00", shipping: "0.00", discount: "0.00", fees: "0.00",
        items: [{ title: "Item de fora", sku: "NAO-EXISTE", quantity: 1, unitPrice: "10.00" }],
      })));
      assert(await db.sale.findFirst({ where: { externalOrderId: "pedido-cat-2" } }));
    });

    await t.test("estoque nunca fica negativo", async () => {
      const escasso = await createProduct(db, ator, { ...produtoBase, sku: "CAT-ESCASSO", stock: 1 });
      const evento = await db.integrationEvent.create({ data: {
        marketplaceId: canal.id, externalEventId: `cat-escasso-${Date.now()}`,
        externalOrderId: "pedido-cat-3", payload: {},
      } });
      await serializable(db, async (tx) => applyIntegratedOrder(tx, {
        marketplaceId: canal.id, organizationId: org.id,
        eventId: evento.id, externalEventId: evento.externalEventId,
      }, parseIntegratedOrder({
        externalOrderId: "pedido-cat-3", status: "PAID", externalStatus: "PAID",
        externalUpdatedAt: "2026-09-19T13:00:00Z", soldAt: "2026-09-19",
        currency: "BRL", gross: "150.00", shipping: "0.00", discount: "0.00", fees: "0.00",
        items: [{ title: "Escasso", sku: "CAT-ESCASSO", quantity: 3, unitPrice: "50.00" }],
      })));
      assert.equal((await db.product.findUniqueOrThrow({ where: { id: escasso.id } })).stock, 0);
    });

    await t.test("o catálogo de outra organização não é alcançável", async () => {
      const outraOrg = await db.organization.create({ data: { name: "Outra do catálogo" } });
      const invasor = await db.user.create({ data: {
        organizationId: outraOrg.id, email: `invasor-${Date.now()}@local.test`,
        name: "Invasor", passwordHash: "x", role: "ADMIN",
      } });
      await assert.rejects(
        updateProduct(db, { userId: invasor.id, organizationId: outraOrg.id }, produtoId, produtoBase),
        (erro: Error) => erro instanceof OrderError && /não encontrado/.test(erro.message),
      );
      await assert.rejects(
        requestPublication(db, { userId: invasor.id, organizationId: outraOrg.id }, produtoId, [canal.id]),
        OrderError,
      );
    });

    await t.test("a listagem traz o produto com os canais", async () => {
      const produtos = await listProducts(db, ator);
      const alvo = produtos.find((p) => p.id === produtoId);
      assert(alvo);
      assert.equal(alvo.listings.length, 1);
      assert.equal(alvo.listings[0].marketplace.code, "sebo");
    });
  } finally { await db.$disconnect(); }
});

test("movimentos de estoque e números do painel em PostgreSQL", async (t) => {
  const db2 = new PrismaClient();
  try {
    const org = await db2.organization.create({ data: { name: "Painel" } });
    const admin = await db2.user.create({ data: {
      organizationId: org.id, email: `admin-painel-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const ator = { userId: admin.id, organizationId: org.id };
    const canal = await db2.marketplace.create({
      data: { organizationId: org.id, code: "sebo", name: "Sebo do painel" },
    });

    const produto = await createProduct(db2, ator, {
      sku: "PAINEL-001", title: "Produto do painel", price: "10.00", stock: 20,
    });

    await t.test("criar o produto já é um movimento", async () => {
      const ms = await db2.stockMovement.findMany({ where: { productId: produto.id } });
      assert.equal(ms.length, 1);
      assert.equal(ms[0].reason, "CREATION");
      assert.equal(ms[0].delta, 20);
      assert.equal(ms[0].balance, 20);
    });

    await t.test("ajuste manual registra delta e saldo", async () => {
      await setProductStock(db2, ator, produto.id, 15);
      const m = await db2.stockMovement.findFirstOrThrow({
        where: { productId: produto.id }, orderBy: { createdAt: "desc" },
      });
      assert.equal(m.reason, "MANUAL");
      assert.equal(m.delta, -5);
      assert.equal(m.balance, 15);
    });

    await t.test("ajuste sem mudança não cria movimento", async () => {
      const antes = await db2.stockMovement.count({ where: { productId: produto.id } });
      await setProductStock(db2, ator, produto.id, 15);
      assert.equal(await db2.stockMovement.count({ where: { productId: produto.id } }), antes);
    });

    await t.test("venda registra o movimento apontando para a venda", async () => {
      const evento = await db2.integrationEvent.create({ data: {
        marketplaceId: canal.id, externalEventId: `painel-venda-${Date.now()}`,
        externalOrderId: "painel-1", payload: {},
      } });
      await serializable(db2, async (tx) => applyIntegratedOrder(tx, {
        marketplaceId: canal.id, organizationId: org.id,
        eventId: evento.id, externalEventId: evento.externalEventId,
      }, parseIntegratedOrder({
        externalOrderId: "painel-1", status: "PAID", externalStatus: "PAID",
        externalUpdatedAt: "2026-09-19T10:00:00Z", soldAt: "2026-09-19",
        currency: "BRL", gross: "30.00", shipping: "0.00", discount: "0.00", fees: "0.00",
        items: [{ title: "Produto do painel", sku: "PAINEL-001", quantity: 3, unitPrice: "10.00" }],
      })));

      const m = await db2.stockMovement.findFirstOrThrow({
        where: { productId: produto.id }, orderBy: { createdAt: "desc" },
      });
      assert.equal(m.reason, "SALE");
      assert.equal(m.delta, -3);
      assert.equal(m.balance, 12);
      const venda = await db2.sale.findFirstOrThrow({ where: { externalOrderId: "painel-1" } });
      assert.equal(m.saleId, venda.id, "o movimento diz de qual venda veio");
    });

    await t.test("o saldo de cada movimento acompanha o estoque do produto", async () => {
      const atual = await db2.product.findUniqueOrThrow({ where: { id: produto.id } });
      const ultimo = await db2.stockMovement.findFirstOrThrow({
        where: { productId: produto.id }, orderBy: { createdAt: "desc" },
      });
      assert.equal(ultimo.balance, atual.stock);

      // A soma dos deltas reconstrói o saldo: é disso que o gráfico vive.
      const todos = await db2.stockMovement.findMany({ where: { productId: produto.id } });
      assert.equal(todos.reduce((s, m) => s + m.delta, 0), atual.stock);
    });

    await t.test("o painel soma unidades e valor em Decimal", async () => {
      await createProduct(db2, ator, { sku: "PAINEL-002", title: "Outro", price: "0.07", stock: 3 });
      const stats = await getProductStats(db2, org.id);
      assert.equal(stats.total, 2);
      assert.equal(stats.unidades, 12 + 3);
      // 12 x 10,00 + 3 x 0,07 = 120,21. Em ponto flutuante daria 120.20999...
      assert.equal(stats.valorEstoque, "120.21");
    });

    await t.test("a série de estoque termina no saldo de hoje e tem 30 dias", async () => {
      const stats = await getProductStats(db2, org.id);
      assert.equal(stats.estoquePorDia.length, 30);
      assert.equal(stats.estoquePorDia[29].unidades, stats.unidades);
      // Antes de qualquer movimento o catálogo estava vazio.
      assert.equal(stats.estoquePorDia[0].unidades, 0);
    });

    await t.test("a série volta no tempo aplicando os deltas ao contrário", async () => {
      const ontem = new Date();
      ontem.setUTCDate(ontem.getUTCDate() - 1);
      const p = await db2.product.findFirstOrThrow({ where: { sku: "PAINEL-002" } });
      await db2.stockMovement.create({ data: {
        productId: p.id, organizationId: org.id, delta: -2, balance: 1,
        reason: "SALE", createdAt: ontem,
      } });
      const stats = await getProductStats(db2, org.id);
      // Todo o catálogo deste teste nasceu hoje, então ontem fechou em zero:
      // a série desfaz os movimentos de hoje ao voltar um dia.
      assert.equal(stats.estoquePorDia[29].unidades, stats.unidades);
      assert.equal(stats.estoquePorDia[28].unidades, 0);
      // E desfazer a baixa de ontem soma as 2 unidades de volta no dia anterior.
      assert.equal(stats.estoquePorDia[27].unidades, 2);
    });

    await t.test("o ranking ignora venda cancelada", async () => {
      const antes = await getProductStats(db2, org.id);
      assert.equal(antes.maisVendidos.find((m) => m.titulo === "Produto do painel")?.unidades, 3);

      const evento = await db2.integrationEvent.create({ data: {
        marketplaceId: canal.id, externalEventId: `painel-cancel-${Date.now()}`,
        externalOrderId: "painel-1", payload: {},
      } });
      await serializable(db2, async (tx) => applyIntegratedOrder(tx, {
        marketplaceId: canal.id, organizationId: org.id,
        eventId: evento.id, externalEventId: evento.externalEventId,
      }, parseIntegratedOrder({
        externalOrderId: "painel-1", status: "CANCELLED", externalStatus: "CANCELLED",
        externalUpdatedAt: "2026-09-19T12:00:00Z", soldAt: "2026-09-19",
        currency: "BRL", gross: "30.00", shipping: "0.00", discount: "0.00", fees: "0.00",
        items: [{ title: "Produto do painel", sku: "PAINEL-001", quantity: 3, unitPrice: "10.00" }],
      })));

      const depois = await getProductStats(db2, org.id);
      assert.equal(depois.maisVendidos.find((m) => m.titulo === "Produto do painel"), undefined);
      // E o cancelamento devolveu o estoque, com movimento próprio.
      const m = await db2.stockMovement.findFirstOrThrow({
        where: { productId: produto.id }, orderBy: { createdAt: "desc" },
      });
      assert.equal(m.reason, "CANCELLATION");
      assert.equal(m.delta, 3);
    });

    await t.test("o painel não enxerga catálogo de outra organização", async () => {
      const outra = await db2.organization.create({ data: { name: "Outra do painel" } });
      const stats = await getProductStats(db2, outra.id);
      assert.equal(stats.total, 0);
      assert.equal(stats.unidades, 0);
      assert.equal(stats.valorEstoque, "0.00");
      assert.equal(stats.maisVendidos.length, 0);
    });
  } finally { await db2.$disconnect(); }
});

test("imagem do produto: URL ou arquivo enviado", async (t) => {
  // PNG 1x1 real, para o base64 ser válido de verdade e não texto inventado.
  const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const dataUri = (tipo: string, corpo = PNG_1X1) => `data:${tipo};base64,${corpo}`;

  await t.test("URL https continua aceita e http continua recusado", () => {
    assert.deepEqual(
      parseProduct({ ...produtoBase, images: ["https://exemplo.invalid/a.png"] }).images,
      ["https://exemplo.invalid/a.png"]);
    assert.throws(() => parseProduct({ ...produtoBase, images: ["http://exemplo.invalid/a.png"] }), OrderError);
  });

  await t.test("arquivo enviado é guardado como data URI", () => {
    const valor = dataUri("image/png");
    assert.deepEqual(parseProduct({ ...produtoBase, images: [valor] }).images, [valor]);
    for (const tipo of ["image/jpeg", "image/webp", "image/gif", "image/avif"]) {
      assert.deepEqual(parseProduct({ ...produtoBase, images: [dataUri(tipo)] }).images, [dataUri(tipo)]);
    }
  });

  await t.test("tipo fora da lista é recusado, mesmo com base64 válido", () => {
    // SVG é documento, não imagem; HTML disfarçado de data URI, menos ainda.
    for (const tipo of ["image/svg+xml", "text/html", "application/pdf"]) {
      assert.throws(
        () => parseProduct({ ...produtoBase, images: [dataUri(tipo)] }),
        (erro: Error) => erro instanceof OrderError && /não aceito|inválid/i.test(erro.message),
        `deveria recusar ${tipo}`);
    }
  });

  await t.test("data URI malformado é recusado antes de chegar ao banco", () => {
    for (const valor of [
      "data:image/png;base64,",                 // sem corpo
      "data:image/png,iVBORw0KGgo=",            // sem base64
      "data:image/png;base64,não-é-base64!!",   // caractere fora do alfabeto
      "data:image/png;base64,iVBORw0KGgo",      // truncado: não é múltiplo de 4
    ]) {
      assert.throws(() => parseProduct({ ...produtoBase, images: [valor] }), OrderError, `deveria recusar ${valor}`);
    }
  });

  await t.test("imagem acima do limite é recusada", () => {
    // Um pouco além do teto: 3 MB de arquivo viram ~4 MB de base64.
    const gigante = "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 200);
    assert.throws(
      () => parseProduct({ ...produtoBase, images: [dataUri("image/png", gigante)] }),
      (erro: Error) => erro instanceof OrderError && /limite/.test(erro.message));
  });

  await t.test("álbum vazio continua opcional", () => {
    assert.deepEqual(parseProduct({ ...produtoBase, images: [] }).images, []);
    assert.deepEqual(parseProduct({ ...produtoBase, images: undefined }).images, []);
  });

  await t.test("o limite de 500 caracteres da URL não alcança o data URI", () => {
    // Regressão: a regra antiga cortava em 500 e recusaria toda imagem enviada.
    const longo = dataUri("image/png", "QUJD".repeat(300));
    assert(longo.length > 500);
    assert.deepEqual(parseProduct({ ...produtoBase, images: [longo] }).images, [longo]);
  });

  await t.test("tipoDeImagemAceito não depende de caixa nem de espaço", () => {
    assert.equal(tipoDeImagemAceito(" IMAGE/PNG "), true);
    assert.equal(tipoDeImagemAceito("image/svg+xml"), false);
  });
});

test("álbum de imagens: validação sem banco", async (t) => {
  const A = "https://exemplo.invalid/a.png";
  const B = "https://exemplo.invalid/b.png";
  const C = "https://exemplo.invalid/c.png";

  await t.test("a ordem enviada é a ordem guardada", () => {
    assert.deepEqual(parseProduct({ ...produtoBase, images: [C, A, B] }).images, [C, A, B]);
  });

  await t.test("repetida é descartada, não recusada", () => {
    // Mandar a mesma foto duas vezes é engano de quem cadastra, e travar o
    // salvamento por isso seria pior que ignorar a segunda.
    assert.deepEqual(parseProduct({ ...produtoBase, images: [A, B, A] }).images, [A, B]);
  });

  await t.test("entrada vazia no meio não abre buraco nas posições", () => {
    assert.deepEqual(parseProduct({ ...produtoBase, images: [A, "", B] }).images, [A, B]);
  });

  await t.test("uma imagem inválida recusa o álbum inteiro", () => {
    // Salvar as válidas e descartar a ruim esconderia o erro de quem cadastrou.
    assert.throws(() => parseProduct({ ...produtoBase, images: [A, "http://x.invalid/b.png"] }), OrderError);
  });

  await t.test("o teto do álbum é respeitado", () => {
    const muitas = Array.from({ length: MAX_IMAGENS }, (_, i) => `https://exemplo.invalid/${i}.png`);
    assert.equal(parseProduct({ ...produtoBase, images: muitas }).images.length, MAX_IMAGENS);
    assert.throws(
      () => parseProduct({ ...produtoBase, images: [...muitas, "https://exemplo.invalid/extra.png"] }),
      (erro: Error) => erro instanceof OrderError && /máximo/.test(erro.message));
  });

  await t.test("o que não é lista é recusado", () => {
    assert.throws(() => parseProduct({ ...produtoBase, images: A }), OrderError);
    assert.throws(() => parseProduct({ ...produtoBase, images: { 0: A } }), OrderError);
  });

  await t.test("o payload do sebo leva só a principal", () => {
    const payload = seboProductPayload({
      sku: "X", title: "T", description: "", category: "", brand: "", condition: "",
      price: new Prisma.Decimal("10.00"), stock: 1, active: true,
      images: [{ url: A }, { url: B }],
    } as never);
    assert.equal(payload.image_url, A);
  });

  await t.test("álbum vazio manda imagem vazia, não indefinida", () => {
    // O contrato do sebo tem image_url como string; undefined viraria ausência
    // do campo e o outro lado decidiria sozinho o que fazer.
    const payload = seboProductPayload({
      sku: "X", title: "T", description: "", category: "", brand: "", condition: "",
      price: new Prisma.Decimal("10.00"), stock: 1, active: true, images: [],
    } as never);
    assert.equal(payload.image_url, "");
  });
});

test("álbum de imagens em PostgreSQL", async (t) => {
  const db3 = new PrismaClient();
  // PNG 1x1 real: o validador confere o base64, e texto inventado seria
  // recusado antes de chegar ao banco.
  const dataUri = (tipo = "image/png") =>
    `data:${tipo};base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==`;
  const A = "https://exemplo.invalid/a.png";
  const B = "https://exemplo.invalid/b.png";
  const C = "https://exemplo.invalid/c.png";
  try {
    const org = await db3.organization.create({ data: { name: "Álbum" } });
    const admin = await db3.user.create({ data: {
      organizationId: org.id, email: `admin-album-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const ator = { userId: admin.id, organizationId: org.id };
    const canal = await db3.marketplace.create({
      data: { organizationId: org.id, code: "sebo", name: "Sebo do álbum" },
    });
    await db3.marketplaceConnection.create({ data: {
      marketplaceId: canal.id, provider: "SEBO_ONLINE",
      externalAccountId: `loja-album-${Date.now()}`, accessToken: "cifrado",
    } });

    const base = { sku: "ALBUM-001", title: "Produto com álbum", price: "10.00", stock: 5 };
    const criado = await createProduct(db3, ator, { ...base, images: [A, B] });

    await t.test("as imagens nascem numeradas a partir de zero", async () => {
      const imagens = await db3.productImage.findMany({
        where: { productId: criado.id }, orderBy: { position: "asc" },
      });
      assert.deepEqual(imagens.map((i) => [i.position, i.url]), [[0, A], [1, B]]);
    });

    await t.test("reordenar troca a principal e marca o anúncio", async () => {
      await requestPublication(db3, ator, criado.id, [canal.id]);
      await syncListings(db3, async (l) => ({
        externalListingId: "sebo-album", price: l.product.price.toFixed(2), stock: l.product.stock,
      }), 10, org.id);
      assert.equal(
        (await db3.listing.findFirstOrThrow({ where: { productId: criado.id } })).needsSync, false);

      await updateProduct(db3, ator, criado.id, { ...base, images: [B, A] });

      const imagens = await db3.productImage.findMany({
        where: { productId: criado.id }, orderBy: { position: "asc" },
      });
      assert.deepEqual(imagens.map((i) => i.url), [B, A]);
      // Mesmo conjunto, ordem diferente: o provedor recebe outra principal.
      assert.equal(
        (await db3.listing.findFirstOrThrow({ where: { productId: criado.id } })).needsSync, true,
        "trocar a principal precisa ressincronizar");
    });

    await t.test("o trabalhador entrega a principal ao adapter", async () => {
      let principal = "";
      await syncListings(db3, async (l) => {
        principal = l.product.images[0]?.url ?? "";
        assert.equal(l.product.images.length, 2, "o adapter recebe o álbum inteiro");
        return { externalListingId: "sebo-album", price: l.product.price.toFixed(2), stock: l.product.stock };
      }, 10, org.id);
      assert.equal(principal, B);
    });

    await t.test("salvar sem mexer no álbum não ressincroniza", async () => {
      await updateProduct(db3, ator, criado.id, { ...base, images: [B, A] });
      assert.equal(
        (await db3.listing.findFirstOrThrow({ where: { productId: criado.id } })).needsSync, false);
    });

    await t.test("acrescentar imagem preserva a principal e marca pendência", async () => {
      await updateProduct(db3, ator, criado.id, { ...base, images: [B, A, C] });
      const imagens = await db3.productImage.findMany({
        where: { productId: criado.id }, orderBy: { position: "asc" },
      });
      assert.deepEqual(imagens.map((i) => i.url), [B, A, C]);
      assert.equal(
        (await db3.listing.findFirstOrThrow({ where: { productId: criado.id } })).needsSync, true);
    });

    await t.test("esvaziar o álbum apaga as linhas", async () => {
      await updateProduct(db3, ator, criado.id, { ...base, images: [] });
      assert.equal(await db3.productImage.count({ where: { productId: criado.id } }), 0);
    });

    await t.test("apagar o produto leva o álbum junto", async () => {
      const outro = await createProduct(db3, ator, {
        sku: "ALBUM-002", title: "Some junto", price: "1.00", stock: 0, images: [A],
      });
      assert.equal(await db3.productImage.count({ where: { productId: outro.id } }), 1);
      await db3.product.delete({ where: { id: outro.id } });
      assert.equal(await db3.productImage.count({ where: { productId: outro.id } }), 0);
    });

    await t.test("a listagem devolve o álbum em ordem", async () => {
      await updateProduct(db3, ator, criado.id, { ...base, images: [C, B, A] });
      const produtos = await listProducts(db3, ator);
      const alvo = produtos.find((p) => p.id === criado.id);
      assert.deepEqual(alvo?.images.map((i) => i.url), [C, B, A]);
    });

    await t.test("salvar com referência não faz a foto viajar de novo", async () => {
      // O defeito que isto corrige: o álbum inteiro em base64 ia junto de cada
      // salvamento, e a partir de um punhado de fotos o corpo da requisição
      // estourava -- salvar virava impossível. Agora a imagem que já está no
      // banco vai como `ref:<id>`.
      const antes = await db3.productImage.findMany({
        where: { productId: criado.id }, orderBy: { position: "asc" },
      });
      const refs = antes.map((i) => `ref:${i.id}`);
      await updateProduct(db3, ator, criado.id, { ...base, title: "Outro título", images: refs });
      const depois = await db3.productImage.findMany({
        where: { productId: criado.id }, orderBy: { position: "asc" },
      });
      // Mesmas linhas, mesmos ids, mesma ordem.
      assert.deepEqual(depois.map((i) => i.id), antes.map((i) => i.id));
      assert.deepEqual(depois.map((i) => i.url), antes.map((i) => i.url));
    });

    await t.test("o id da imagem sobrevive à edição", async () => {
      // O id é endereço público: o anúncio no catálogo do Meta leva
      // `/api/product-images/{id}`. Recriar as linhas a cada salvamento
      // transformava toda URL já anunciada em 404, sem erro deste lado.
      const antes = await db3.productImage.findMany({ where: { productId: criado.id } });
      await updateProduct(db3, ator, criado.id, {
        ...base, price: "11.00", images: antes.map((i) => `ref:${i.id}`),
      });
      const depois = await db3.productImage.findMany({ where: { productId: criado.id } });
      assert.deepEqual(
        depois.map((i) => i.id).sort(), antes.map((i) => i.id).sort(),
        "editar o produto não pode trocar o id das imagens");
    });

    await t.test("referência reordena sem colidir com a posição de quem fica", async () => {
      const antes = await db3.productImage.findMany({
        where: { productId: criado.id }, orderBy: { position: "asc" },
      });
      const invertido = [...antes].reverse();
      await updateProduct(db3, ator, criado.id, {
        ...base, images: invertido.map((i) => `ref:${i.id}`),
      });
      const depois = await db3.productImage.findMany({
        where: { productId: criado.id }, orderBy: { position: "asc" },
      });
      assert.deepEqual(depois.map((i) => i.id), invertido.map((i) => i.id));
      assert.deepEqual(depois.map((i) => i.position), depois.map((_, i) => i));
    });

    await t.test("referência de imagem de outro produto é recusada", async () => {
      const outro = await createProduct(db3, ator, {
        sku: "ALBUM-002", title: "Outro produto", price: "10.00", stock: 1, images: [C],
      });
      const alheia = await db3.productImage.findFirstOrThrow({ where: { productId: outro.id } });
      // Aceitar seria deixar um formulário adotar a imagem de outro catálogo.
      await assert.rejects(
        updateProduct(db3, ator, criado.id, { ...base, images: [`ref:${alheia.id}`] }),
        (e: Error) => e instanceof OrderError && /não encontrada/.test(e.message));
    });

    await t.test("anexar entra no fim do álbum e marca o anúncio", async () => {
      const dataUriPng = dataUri();
      const antes = await db3.productImage.count({ where: { productId: criado.id } });
      await db3.listing.updateMany({ where: { productId: criado.id }, data: { needsSync: false } });

      const nova = await appendProductImage(db3, ator, criado.id, dataUriPng);
      const imagens = await db3.productImage.findMany({
        where: { productId: criado.id }, orderBy: { position: "asc" },
      });
      assert.equal(imagens.length, antes + 1);
      assert.equal(imagens[imagens.length - 1].id, nova.id);
      assert.equal(imagens[imagens.length - 1].position, antes);
      // O álbum mudou: o canal precisa receber de novo. Quem salva o produto
      // depois já vê o álbum igual ao do banco e não marcaria nada.
      const anuncio = await db3.listing.findFirst({ where: { productId: criado.id } });
      assert.equal(anuncio?.needsSync, true);
    });

    await t.test("anexar a mesma foto duas vezes não duplica", async () => {
      const antes = await db3.productImage.count({ where: { productId: criado.id } });
      const repetida = await appendProductImage(db3, ator, criado.id, dataUri());
      assert.equal(repetida.repetida, true);
      assert.equal(await db3.productImage.count({ where: { productId: criado.id } }), antes);
    });

    await t.test("anexar respeita o teto e a organização", async () => {
      await assert.rejects(
        appendProductImage(db3, { userId: admin.id, organizationId: "outra" }, criado.id, C),
        OrderError);

      const cheio = await createProduct(db3, ator, {
        sku: "ALBUM-003", title: "Álbum cheio", price: "10.00", stock: 1,
        images: Array.from({ length: MAX_IMAGENS }, (_, i) => `https://exemplo.invalid/cheio-${i}.png`),
      });
      await assert.rejects(
        appendProductImage(db3, ator, cheio.id, "https://exemplo.invalid/extra.png"),
        (e: Error) => e instanceof OrderError && /máximo/.test(e.message));
    });
  } finally { await db3.$disconnect(); }
});

test("canal com mais de uma conta conectada", async (t) => {
  const db5 = new PrismaClient();
  try {
    const org = await db5.organization.create({ data: { name: "Duas contas" } });
    const admin = await db5.user.create({ data: {
      organizationId: org.id, email: `admin-contas-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const ator = { userId: admin.id, organizationId: org.id };
    const canal = await db5.marketplace.create({
      data: { organizationId: org.id, code: "mercado_livre", name: "ML de duas contas" },
    });
    const real = await db5.marketplaceConnection.create({ data: {
      marketplaceId: canal.id, provider: "MERCADO_LIVRE",
      externalAccountId: `real-${Date.now()}`, accessToken: "cifrado",
    } });
    const teste = await db5.marketplaceConnection.create({ data: {
      marketplaceId: canal.id, provider: "MERCADO_LIVRE",
      externalAccountId: `teste-${Date.now()}`, accessToken: "cifrado",
    } });
    const produto = await createProduct(db5, ator, {
      sku: "CONTA-001", title: "Produto de duas contas", price: "10.00", stock: 2,
    });

    await t.test("regressão: com duas contas e nenhuma escolha, recusa em vez de adivinhar", async () => {
      // Antes disto a publicação caía num findFirst sem critério e ia para a
      // conta que o banco devolvesse primeiro -- na prática, a real.
      await assert.rejects(
        requestPublication(db5, ator, produto.id, [canal.id]),
        (e: Error) => e instanceof OrderError
          && /mais de uma conta conectada/.test(e.message)
          && e.message.includes(real.externalAccountId)
          && e.message.includes(teste.externalAccountId));
      assert.equal(await db5.listing.count({ where: { productId: produto.id } }), 0,
        "recusar não pode deixar anúncio pela metade");
    });

    await t.test("a conta escolhida é a que fica gravada no anúncio", async () => {
      await requestPublication(db5, ator, produto.id, [canal.id], { [canal.id]: teste.id });
      const listing = await db5.listing.findFirstOrThrow({ where: { productId: produto.id } });
      assert.equal(listing.connectionId, teste.id);
    });

    await t.test("republicar mantém a conta sem precisar reescolher", async () => {
      await requestPublication(db5, ator, produto.id, [canal.id]);
      const listing = await db5.listing.findFirstOrThrow({ where: { productId: produto.id } });
      assert.equal(listing.connectionId, teste.id, "a conta do anúncio decide quando não há escolha nova");
    });

    await t.test("a credencial usada é a da conta gravada no anúncio", async () => {
      const listing = await db5.listing.findFirstOrThrow({ where: { productId: produto.id } });
      const usada = await db5.marketplaceConnection.findUniqueOrThrow({
        where: { id: listing.connectionId! }, select: { externalAccountId: true },
      });
      // É esta conexão que o publicador lê por id. Escolhendo sozinho, ele
      // pegaria a outra conta -- que foi o defeito.
      assert.equal(usada.externalAccountId, teste.externalAccountId);
      assert.notEqual(usada.externalAccountId, real.externalAccountId);
    });

    await t.test("trocar a conta de um anúncio publicado é recusado", async () => {
      await db5.listing.updateMany({
        where: { productId: produto.id }, data: { status: "PUBLISHED", externalListingId: "MLB1" },
      });
      await assert.rejects(
        requestPublication(db5, ator, produto.id, [canal.id], { [canal.id]: real.id }),
        (e: Error) => e instanceof OrderError && /Despublique lá antes/.test(e.message),
        "trocar de conta deixaria o anúncio antigo órfão na conta anterior");
    });

    await t.test("canal com uma conta só continua sem exigir escolha", async () => {
      const soUma = await db5.marketplace.create({
        data: { organizationId: org.id, code: "sebo", name: "Sebo de uma conta" },
      });
      const unica = await db5.marketplaceConnection.create({ data: {
        marketplaceId: soUma.id, provider: "SEBO_ONLINE",
        externalAccountId: `unica-${Date.now()}`, accessToken: "cifrado",
      } });
      await requestPublication(db5, ator, produto.id, [soUma.id]);
      const listing = await db5.listing.findFirstOrThrow({
        where: { productId: produto.id, marketplaceId: soUma.id },
      });
      assert.equal(listing.connectionId, unica.id);
    });
  } finally { await db5.$disconnect(); }
});

test("mudança de título chega ao canal", async (t) => {
  const db6 = new PrismaClient();
  try {
    const org = await db6.organization.create({ data: { name: "Título" } });
    const admin = await db6.user.create({ data: {
      organizationId: org.id, email: `admin-titulo-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const ator = { userId: admin.id, organizationId: org.id };
    const canal = await db6.marketplace.create({
      data: { organizationId: org.id, code: "sebo", name: "Sebo do título" },
    });
    await db6.marketplaceConnection.create({ data: {
      marketplaceId: canal.id, provider: "SEBO_ONLINE",
      externalAccountId: `loja-tit-${Date.now()}`, accessToken: "cifrado",
    } });

    const base = { sku: "TITULO-001", title: "Nome original", price: "10.00", stock: 3 };
    const produto = await createProduct(db6, ator, base);
    await requestPublication(db6, ator, produto.id, [canal.id]);

    const publicar = async () => {
      const enviados: string[] = [];
      await syncListings(db6, async (l) => {
        enviados.push(l.product.title);
        return { externalListingId: "sebo-tit", price: l.product.price.toFixed(2), stock: l.product.stock };
      }, 10, org.id);
      return enviados;
    };

    await t.test("a primeira publicação envia o título original", async () => {
      assert.deepEqual(await publicar(), ["Nome original"]);
    });

    await t.test("regressão: trocar só o título faz o anúncio ir ao canal de novo", async () => {
      // Antes, a comparação olhava preço, estoque, imagens e categoria. O
      // título mudado marcava o anúncio como pendente, o trabalhador o dava
      // como em dia e desligava a marca sem chamar o provedor: o canal ficava
      // com o nome velho para sempre, sem erro nenhum.
      await updateProduct(db6, ator, produto.id, { ...base, title: "Nome novo" });
      const pendente = await db6.listing.findFirstOrThrow({ where: { productId: produto.id } });
      assert.equal(pendente.needsSync, true);

      assert.deepEqual(await publicar(), ["Nome novo"]);
      const depois = await db6.listing.findFirstOrThrow({ where: { productId: produto.id } });
      assert.equal(depois.needsSync, false);
    });

    await t.test("e sem mudança nenhuma, não chama o provedor", async () => {
      assert.deepEqual(await publicar(), []);
    });

    await t.test("descrição também é publicável", async () => {
      await updateProduct(db6, ator, produto.id, {
        ...base, title: "Nome novo", description: "Uma descrição nova",
      });
      assert.deepEqual(await publicar(), ["Nome novo"], "voltou ao provedor por causa da descrição");
    });
  } finally { await db6.$disconnect(); }
});

test("venda empurra o estoque aos canais na hora", async (t) => {
  const db7 = new PrismaClient();
  try {
    const org = await db7.organization.create({ data: { name: "Empurrão" } });
    const admin = await db7.user.create({ data: {
      organizationId: org.id, email: `admin-push-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const ator = { userId: admin.id, organizationId: org.id };
    const canal = await db7.marketplace.create({
      data: { organizationId: org.id, code: "sebo", name: "Sebo do empurrão" },
    });
    await db7.marketplaceConnection.create({ data: {
      marketplaceId: canal.id, provider: "SEBO_ONLINE",
      externalAccountId: `loja-push-${Date.now()}`, accessToken: "cifrado",
    } });

    const produto = await createProduct(db7, ator, {
      sku: "PUSH-001", title: "Produto do empurrão", price: "10.00", stock: 5,
    });
    await requestPublication(db7, ator, produto.id, [canal.id]);
    const publicador: ListingPublisher = async (l) => ({
      externalListingId: "sebo-push", price: l.product.price.toFixed(2), stock: l.product.stock,
    });
    await syncListings(db7, publicador, 10, org.id);

    const evento = await db7.integrationEvent.create({ data: {
      marketplaceId: canal.id, externalEventId: `push-${Date.now()}`,
      externalOrderId: "pedido-push", payload: {},
    } });
    await serializable(db7, async (tx) => applyIntegratedOrder(tx, {
      marketplaceId: canal.id, organizationId: org.id,
      eventId: evento.id, externalEventId: evento.externalEventId,
    }, parseIntegratedOrder({
      externalOrderId: "pedido-push", status: "PAID", externalStatus: "PAID",
      externalUpdatedAt: "2026-09-20T01:00:00Z", soldAt: "2026-09-20",
      currency: "BRL", gross: "20.00", shipping: "0.00", discount: "0.00", fees: "0.00",
      items: [{ title: "Produto do empurrão", sku: "PUSH-001", quantity: 2, unitPrice: "10.00" }],
    })));

    await t.test("o canal recebe o estoque novo sem esperar o agendador", async () => {
      const pendente = await db7.listing.findFirstOrThrow({ where: { productId: produto.id } });
      assert.equal(pendente.needsSync, true, "a venda deixou o anúncio pendente");

      const enviados: number[] = [];
      const resultado = await pushAposVenda(db7, async (l) => {
        enviados.push(l.product.stock);
        return { externalListingId: "sebo-push", price: l.product.price.toFixed(2), stock: l.product.stock };
      }, evento.id);

      assert.deepEqual(enviados, [3], "5 menos as 2 unidades vendidas");
      assert.equal(resultado.empurrados, 1);
      assert.equal(
        (await db7.listing.findFirstOrThrow({ where: { id: pendente.id } })).needsSync, false);
    });

    await t.test("falhar no empurrão não propaga: o agendador recupera", async () => {
      // Mudança de verdade: ligar a marca à mão não bastaria, porque o
      // trabalhador compara a impressão e concluiria -- com razão -- que não
      // há o que enviar.
      await setProductStock(db7, ator, produto.id, 1);
      // Não lança: o evento já foi processado com sucesso e não pode ser
      // afetado por um problema na aceleração.
      const resultado = await pushAposVenda(db7, async () => { throw new Error("provedor fora"); }, evento.id);
      assert.deepEqual(resultado, { empurrados: 0 });
      assert.equal(
        (await db7.listing.findFirstOrThrow({ where: { productId: produto.id } })).needsSync, true,
        "segue pendente para o agendador");
    });

    await t.test("evento inexistente não quebra", async () => {
      assert.deepEqual(await pushAposVenda(db7, publicador, "nao-existe"), { empurrados: 0 });
    });
  } finally { await db7.$disconnect(); }
});

test("falha depois de o anúncio existir no provedor", async (t) => {
  const db8 = new PrismaClient();
  try {
    const org = await db8.organization.create({ data: { name: "Parcial" } });
    const admin = await db8.user.create({ data: {
      organizationId: org.id, email: `admin-parcial-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const ator = { userId: admin.id, organizationId: org.id };
    const canal = await db8.marketplace.create({
      data: { organizationId: org.id, code: "mercado_livre", name: "ML parcial" },
    });
    await db8.marketplaceConnection.create({ data: {
      marketplaceId: canal.id, provider: "MERCADO_LIVRE",
      externalAccountId: `conta-parcial-${Date.now()}`, accessToken: "cifrado",
    } });
    const produto = await createProduct(db8, ator, {
      sku: "PARCIAL-001", title: "Camiseta", description: "Ligue 11 99999-9999",
      price: "79.90", stock: 5, brand: "Omnicommerce", images: ["https://exemplo.invalid/a.png"],
    });
    await requestPublication(db8, ator, produto.id, [canal.id]);

    await t.test("o identificador é gravado junto da falha", async () => {
      // O provedor criou o anúncio e recusou a descrição: é o caso em que
      // deixar o erro subir puro perderia o identificador.
      const resultado = await syncListings(db8, async (l) => {
        throw new PartialPublishError(
          { externalListingId: "MLB999", price: l.product.price.toFixed(2), stock: l.product.stock,
            externalStatus: "active", sentAttributes: [{ id: "BRAND", value_name: "Omnicommerce" }] },
          new OrderError("O Mercado Livre recusou a descrição do anúncio: contact information"));
      }, 10, org.id);
      assert.equal(resultado.falhas, 1);
      assert.equal(resultado.publicados, 0, "não é publicação bem-sucedida");

      const listing = await db8.listing.findFirstOrThrow({ where: { productId: produto.id } });
      assert.equal(listing.externalListingId, "MLB999", "sem isto a próxima tentativa duplicaria");
      assert.equal(listing.publishedPrice?.toFixed(2), "79.90");
      assert.equal(listing.externalStatus, "active");
      assert.deepEqual(listing.publishedAttributes, [{ id: "BRAND", value_name: "Omnicommerce" }]);
      // Recusa de conteúdo não melhora com o tempo: desiste e espera correção,
      // com a causa do provedor legível para quem vai corrigir.
      assert.equal(listing.status, "FAILED");
      assert.equal(listing.needsSync, false);
      assert.match(listing.lastError ?? "", /descrição/);
      // A impressão fica de fora: o anúncio existe, mas não está como o
      // produto pede. Se fosse gravada, o anúncio passaria por em dia.
      assert.equal(listing.publishedFingerprint, null);
    });

    await t.test("a tentativa seguinte atualiza o anúncio, não cria outro", async () => {
      await requestPublication(db8, ator, produto.id, [canal.id]);
      const recebidos: (string | null)[] = [];
      await syncListings(db8, async (l) => {
        recebidos.push(l.externalListingId);
        return { externalListingId: l.externalListingId ?? "novo",
                 price: l.product.price.toFixed(2), stock: l.product.stock };
      }, 10, org.id);
      // O adapter recebe o identificador e segue pelo caminho de atualização.
      assert.deepEqual(recebidos, ["MLB999"]);
      assert.equal(await db8.listing.count({ where: { productId: produto.id } }), 1);
      const listing = await db8.listing.findFirstOrThrow({ where: { productId: produto.id } });
      assert.equal(listing.status, "PUBLISHED");
      assert.equal(listing.needsSync, false);
      assert.notEqual(listing.publishedFingerprint, null);
    });

    await t.test("falha parcial transitória continua pendente, com o identificador", async () => {
      const outro = await createProduct(db8, ator, {
        sku: "PARCIAL-002", title: "Outra camiseta", description: "Texto",
        price: "49.90", stock: 2, brand: "Omnicommerce", images: ["https://exemplo.invalid/b.png"],
      });
      await requestPublication(db8, ator, outro.id, [canal.id]);
      await syncListings(db8, async (l) => {
        throw new PartialPublishError(
          { externalListingId: "MLB1000", price: l.product.price.toFixed(2), stock: l.product.stock },
          new Error("rede caiu no meio"));
      }, 10, org.id);

      const listing = await db8.listing.findFirstOrThrow({ where: { productId: outro.id } });
      assert.equal(listing.externalListingId, "MLB1000");
      assert.equal(listing.needsSync, true, "transitório volta para a fila");
      assert.equal(listing.status, "PUBLISHING");
      assert.equal(listing.lastError, "PUBLICACAO_FALHOU");
      assert.equal(listing.attempts, 1);
    });
  } finally { await db8.$disconnect(); }
});
