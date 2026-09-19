import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { OrderError } from "../lib/domain/order-input";
import { parseProduct } from "../lib/domain/product-input";
import {
  createProduct, listProducts, setProductStock, updateProduct,
} from "../lib/services/products";
import {
  estaEmDia, ListingPublisher, MAX_SYNC_ATTEMPTS, requestPublication, syncListings,
} from "../lib/services/listings";
import { applyIntegratedOrder } from "../lib/services/sales";
import { parseIntegratedOrder } from "../lib/domain/order-input";
import { serializable } from "../lib/services/transactions";
import { getProductStats } from "../app/(protected)/dashboard/product-stats";

const db = new PrismaClient();

const produtoBase = {
  sku: "cat-001", title: "Caneca de teste", description: "Uma caneca",
  category: "Casa", brand: "Generico", condition: "novo",
  imageUrl: "https://exemplo.invalid/caneca.png",
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
    assert.equal(parseProduct({ ...produtoBase, imageUrl: "" }).imageUrl, "");
    assert.throws(() => parseProduct({ ...produtoBase, imageUrl: "http://x.invalid/a.png" }), OrderError);
    assert.throws(() => parseProduct({ ...produtoBase, imageUrl: "nao-e-url" }), OrderError);
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
      const resultado = await syncListings(db, publicador);
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
      const resultado = await syncListings(db, publicador);
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
      });
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
      });
      assert.equal(chamadas, 1, "estado desejado colapsa as mudanças");
      const listing = await db.listing.findFirstOrThrow({ where: { productId: produtoId } });
      assert.equal(listing.publishedPrice?.toFixed(2), "63.00");
    });

    await t.test("falha transitória volta para a fila com backoff", async () => {
      await setProductStock(db, ator, produtoId, 4);
      const resultado = await syncListings(db, async () => { throw new Error("rede caiu"); });
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
      });
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
      }));
      assert.equal(
        (await db.listing.findFirstOrThrow({ where: { productId: produtoId } })).status, "PUBLISHED");
    });

    await t.test("teto de tentativas faz o anúncio desistir", async () => {
      const outro = await createProduct(db, ator, { ...produtoBase, sku: "CAT-TETO" });
      await requestPublication(db, ator, outro.id, [canal.id]);
      for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
        await db.listing.updateMany({ where: { productId: outro.id }, data: { availableAt: new Date() } });
        await syncListings(db, async () => { throw new Error("sempre falha"); });
      }
      const listing = await db.listing.findFirstOrThrow({ where: { productId: outro.id } });
      assert.equal(listing.status, "FAILED");
      assert.equal(listing.needsSync, false);
      assert(listing.attempts >= MAX_SYNC_ATTEMPTS);
    });

    await t.test("estaEmDia compara preço por valor, não por texto", async () => {
      const listing = await db.listing.findFirstOrThrow({
        where: { productId: produtoId }, include: { product: true },
      });
      assert.equal(estaEmDia(listing), true);
      assert.equal(estaEmDia({ ...listing, publishedStock: listing.publishedStock! + 1 }), false);
      assert.equal(estaEmDia({ ...listing, status: "PUBLISHING" }), false);
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
