import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import { OrderError } from "../lib/domain/order-input";
import { ProviderAuthError, ProviderTransientError } from "../lib/integrations/mercadolivre/client";
import {
  assinarShopee, assinaturaDePushValida, listChangedShopeeOrders, fetchShopeeOrder,
  shopeeConfig, shopeeConfigured,
} from "../lib/integrations/shopee/client";
import {
  condicaoShopee, impressaoDeConteudo, prepararImagensShopee, publishShopeeListing,
} from "../lib/integrations/shopee/catalog";
import { normalizeShopeeOrder } from "../lib/integrations/shopee/normalize";
import {
  exchangeShopeeCode, lerRetornoDeAutorizacao, refreshShopeeToken, shopeeAuthorizationUrl,
} from "../lib/integrations/shopee/oauth";
import { parseShopeeNotification } from "../lib/integrations/shopee/notification";
import { PartialPublishError } from "../lib/services/listings";
import type { ListingWithProduct } from "../lib/services/listings";

const PARTNER_ID = "2000123";
const PARTNER_KEY = "chave-de-teste-da-shopee";
const PNG = "data:image/png;base64,QUJD";

const ambiente = {
  SHOPEE_PARTNER_ID: PARTNER_ID,
  SHOPEE_PARTNER_KEY: PARTNER_KEY,
  SHOPEE_SANDBOX: "true",
  SHOPEE_HOST: undefined,
  SHOPEE_DEFAULT_WEIGHT_KG: undefined,
  APP_URL: "https://omnicommerce.vercel.app",
};

function comAmbiente<T>(vars: Record<string, string | undefined>, corpo: () => T): T {
  const anterior = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  const restaurar = () => {
    for (const [k, v] of anterior) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let resultado: T;
  try {
    resultado = corpo();
  } catch (erro) {
    restaurar();
    throw erro;
  }
  if (resultado instanceof Promise) return resultado.finally(restaurar) as T;
  restaurar();
  return resultado;
}

const loja = { accessToken: "token-da-loja", shopId: "77001" };

function anuncio(over: Partial<ListingWithProduct> = {}, produtoOver = {}): ListingWithProduct {
  const produto = {
    id: "p1", organizationId: "o1", sku: "CAM-1", title: "Camiseta de teste",
    description: "Malha de algodão.", category: "", brand: "Omnicommerce", condition: "novo",
    price: new Prisma.Decimal("79.90"), currency: "BRL", stock: 5, active: true,
    createdAt: new Date(), updatedAt: new Date(),
    images: [{ id: "i1", productId: "p1", position: 0, url: PNG, createdAt: new Date() }],
    ...produtoOver,
  };
  return {
    id: "l1", productId: "p1", marketplaceId: "m1", connectionId: "c1", status: "PUBLISHING",
    externalListingId: null, publishedPrice: null, publishedStock: null,
    publishedFingerprint: null, categoryExternalId: "100182", publishedCategoryId: null,
    publishedAttributes: null, attributes: null, lastPublishedAt: null, externalStatus: null,
    needsSync: true, availableAt: new Date(), attempts: 0, lastError: null,
    leaseUntil: null, leaseToken: null, createdAt: new Date(), updatedAt: new Date(),
    product: produto,
    ...over,
  } as unknown as ListingWithProduct;
}

/// Dublê por rota, com o método na chave quando a mesma URL responde diferente
/// a cada verbo. Registra a URL inteira: na Shopee os parâmetros assinados vão
/// na query, e é isso que se quer conferir.
function provedor(rotas: Record<string, { status?: number; corpo: unknown }>) {
  const chamadas: { url: string; metodo: string; corpo: unknown }[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const metodo = init.method ?? "GET";
    let enviado: unknown = null;
    if (typeof init.body === "string") enviado = JSON.parse(init.body);
    else if (init.body instanceof FormData) {
      const arquivo = init.body.get("image");
      enviado = arquivo instanceof File
        ? { multipart: true, nome: arquivo.name, tipo: arquivo.type } : { multipart: true };
    }
    chamadas.push({ url, metodo, corpo: enviado });
    const chave = Object.keys(rotas).find((r) => {
      const [m, rota] = r.includes(" ") ? r.split(" ") : ["", r];
      return url.includes(rota) && (!m || m === metodo);
    });
    if (!chave) return new Response(JSON.stringify({ error: "error_not_found" }), { status: 200 });
    const rota = rotas[chave];
    return new Response(JSON.stringify(rota.corpo), {
      status: rota.status ?? 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, chamadas };
}

/// Rotas de uma criação bem-sucedida. No escopo do módulo porque publicar toca
/// três rotas -- upload, logística e criação -- e um teste que registre só uma
/// delas falha na primeira, escondendo o que ele queria medir.
const criacao = {
  "/media_space/upload_image": { corpo: { error: "", response: { image_info: { image_id: "img-1" } } } },
  "/logistics/get_channel_list": {
    corpo: {
      error: "",
      response: {
        logistics_channel_list: [
          { logistics_channel_id: 90001, enabled: true },
          { logistics_channel_id: 90002, enabled: false },
        ],
      },
    },
  },
  "/product/add_item": { corpo: { error: "", response: { item_id: 550011, item_status: "NORMAL" } } },
};

const parametro = (url: string, nome: string) => new URL(url).searchParams.get(nome);

test("assinatura da Shopee", async (t) => {
  await t.test("a base é partner_id + caminho + timestamp, nessa ordem", () => {
    comAmbiente(ambiente, () => {
      const config = shopeeConfig();
      const caminho = "/api/v2/product/add_item";
      // A base é escrita à mão aqui de propósito: é ELA que o teste protege.
      // Um campo fora de ordem produz assinatura válida em forma e errada em
      // valor, e o provedor responde error_sign sem dizer qual parte divergiu.
      const esperada = createHmac("sha256", PARTNER_KEY)
        .update(`${PARTNER_ID}${caminho}1700000000`).digest("hex");
      assert.equal(assinarShopee(config, caminho, 1700000000), esperada);
    });
  });

  await t.test("chamada de loja acrescenta token e shop_id, depois do timestamp", () => {
    comAmbiente(ambiente, () => {
      const config = shopeeConfig();
      const caminho = "/api/v2/order/get_order_detail";
      const esperada = createHmac("sha256", PARTNER_KEY)
        .update(`${PARTNER_ID}${caminho}1700000000${loja.accessToken}${loja.shopId}`).digest("hex");
      assert.equal(assinarShopee(config, caminho, 1700000000, loja), esperada);
      // E é diferente da pública: se fossem iguais, metade das rotas falharia.
      assert.notEqual(
        assinarShopee(config, caminho, 1700000000, loja),
        assinarShopee(config, caminho, 1700000000));
    });
  });

  await t.test("trocar a ordem de token e loja muda a assinatura", () => {
    comAmbiente(ambiente, () => {
      const config = shopeeConfig();
      const certa = assinarShopee(config, "/x", 1, { accessToken: "a", shopId: "b" });
      const trocada = assinarShopee(config, "/x", 1, { accessToken: "b", shopId: "a" });
      assert.notEqual(certa, trocada);
    });
  });

  await t.test("configuração ausente ou inválida é nomeada", () => {
    comAmbiente({ ...ambiente, SHOPEE_PARTNER_ID: undefined }, () => {
      assert.equal(shopeeConfigured(), false);
      assert.throws(() => shopeeConfig(), /SHOPEE_PARTNER_ID/);
    });
    comAmbiente({ ...ambiente, SHOPEE_PARTNER_ID: "abc" }, () => {
      assert.throws(() => shopeeConfig(), /numérico/);
    });
  });

  await t.test("sandbox e produção são hosts diferentes", () => {
    comAmbiente(ambiente, () => {
      assert.equal(shopeeConfig().sandbox, true);
      assert.match(shopeeConfig().host, /test-stable/);
    });
    comAmbiente({ ...ambiente, SHOPEE_SANDBOX: "false" }, () => {
      assert.equal(shopeeConfig().sandbox, false);
      assert.equal(shopeeConfig().host, "https://partner.shopeemobile.com");
    });
  });
});

test("erro da Shopee vem dentro de HTTP 200", async (t) => {
  await t.test("credencial recusada é erro de autorização, não sucesso", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor({
        "/order/get_order_detail": { corpo: { error: "error_auth", message: "invalid token" } },
      });
      // Tratar response.ok como sucesso faria toda falha de credencial passar
      // por pedido consultado -- este é o teste que impede isso.
      await assert.rejects(fetchShopeeOrder(loja, "2001", fetcher),
        (e: Error) => e instanceof ProviderAuthError);
    });
  });

  await t.test("erro de servidor é temporário e volta para a fila", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor({
        "/order/get_order_detail": { corpo: { error: "error_server" } },
      });
      await assert.rejects(fetchShopeeOrder(loja, "2001", fetcher),
        (e: Error) => e instanceof ProviderTransientError);
    });
  });

  await t.test("erro de domínio carrega a mensagem do provedor", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor({
        ...criacao,
        "/product/add_item": { corpo: { error: "error_param", message: "category_id is invalid" } },
      });
      await assert.rejects(publishShopeeListing(loja, anuncio(), fetcher),
        (e: Error) => e instanceof OrderError && /category_id is invalid/.test(e.message));
    });
  });

  await t.test("sucesso sem conteúdo é recusado em vez de virar vazio", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor({ "/order/get_order_detail": { corpo: { error: "" } } });
      await assert.rejects(fetchShopeeOrder(loja, "2001", fetcher),
        (e: Error) => e instanceof OrderError && /sem conteúdo/.test(e.message));
    });
  });
});

test("autorização de loja na Shopee", async (t) => {
  await t.test("o link leva partner_id, sign e o nonce no caminho do retorno", () => {
    comAmbiente(ambiente, () => {
      const url = shopeeAuthorizationUrl("nonce-123");
      assert.equal(parametro(url, "partner_id"), PARTNER_ID);
      assert.match(url, /test-stable/);
      assert.ok(parametro(url, "sign"));
      // O nonce no caminho, e não na query: a Shopee cola code e shop_id na URL
      // de retorno e não tem parâmetro de estado.
      assert.equal(
        parametro(url, "redirect"),
        "https://omnicommerce.vercel.app/api/integrations/shopee/callback/nonce-123");
    });
  });

  await t.test("o retorno traz code e shop_id; conta principal é recusada com clareza", () => {
    const bom = lerRetornoDeAutorizacao(new URLSearchParams("code=abc&shop_id=77001"));
    assert.deepEqual(bom, { code: "abc", shopId: "77001" });

    assert.throws(() => lerRetornoDeAutorizacao(new URLSearchParams("shop_id=1")),
      (e: Error) => e instanceof OrderError && /sem código/.test(e.message));
    // Autorização por conta principal não é suportada, e dizer isso vale mais
    // que um erro genérico de parâmetro.
    assert.throws(() => lerRetornoDeAutorizacao(new URLSearchParams("code=abc&main_account_id=9")),
      (e: Error) => e instanceof OrderError && /conta principal/.test(e.message));
  });

  await t.test("troca do código devolve token de 4h e refresh, com a loja como conta", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher, chamadas } = provedor({
        "/auth/token/get": {
          corpo: {
            error: "", access_token: "token-novo", refresh_token: "refresh-novo",
            expire_in: 14400,
          },
        },
      });
      const tokens = await exchangeShopeeCode("codigo", "77001", fetcher);
      assert.equal(tokens.accessToken, "token-novo");
      assert.equal(tokens.refreshToken, "refresh-novo");
      // O shop_id NÃO sai da resposta: ele vem do retorno do provedor e é o
      // identificador da conexão.
      assert.equal(tokens.externalAccountId, "77001");
      assert.ok(tokens.expiresAt && tokens.expiresAt.getTime() > Date.now() + 3 * 3600_000);
      // A resposta de token vem na RAIZ, sem envelope `response`.
      assert.deepEqual(chamadas[0].corpo,
        { code: "codigo", shop_id: 77001, partner_id: Number(PARTNER_ID) });
    });
  });

  await t.test("renovação guarda o refresh novo, porque o antigo deixa de valer", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor({
        "/auth/access_token/get": {
          corpo: { error: "", access_token: "t2", refresh_token: "r2", expire_in: 14400 },
        },
      });
      const tokens = await refreshShopeeToken("r1", "77001", fetcher);
      assert.equal(tokens.refreshToken, "r2", "sem isto, 365 dias de autorização viram 30");
    });
  });
});

test("publicação na Shopee", async (t) => {
  await t.test("a criação leva categoria, estoque de vendedor, logística e imagem", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher, chamadas } = provedor(criacao);
      const resultado = await publishShopeeListing(loja, anuncio(), fetcher);
      assert.equal(resultado.externalListingId, "550011");
      assert.equal(resultado.price, "79.90");
      assert.equal(resultado.stock, 5);

      const criar = chamadas.find((c) => c.url.includes("/product/add_item"))!;
      const corpo = criar.corpo as Record<string, unknown>;
      assert.equal(corpo.item_name, "Camiseta de teste");
      assert.equal(corpo.description, "Malha de algodão.");
      assert.equal(corpo.category_id, 100182);
      assert.equal(corpo.original_price, 79.9);
      assert.deepEqual(corpo.seller_stock, [{ stock: 5 }]);
      assert.deepEqual(corpo.image, { image_id_list: ["img-1"] });
      // Só canal habilitado na loja: desabilitado no corpo faria o provedor
      // recusar o anúncio inteiro.
      assert.deepEqual(corpo.logistic_info, [{ logistic_id: 90001, enabled: true }]);
      assert.equal(corpo.weight, 0.5);
      // A assinatura de chamada de loja vai na query, junto do token.
      assert.equal(parametro(criar.url, "shop_id"), "77001");
      assert.ok(parametro(criar.url, "sign"));
    });
  });

  await t.test("loja sem canal de entrega é recusada com o que fazer", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor({
        ...criacao,
        "/logistics/get_channel_list": {
          corpo: { error: "", response: { logistics_channel_list: [{ logistics_channel_id: 1, enabled: false }] } },
        },
      });
      await assert.rejects(publishShopeeListing(loja, anuncio(), fetcher),
        (e: Error) => e instanceof OrderError && /Seller Center/.test(e.message));
    });
  });

  await t.test("imagem por URL é recusada por nós: a Shopee só aceita upload", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor(criacao);
      await assert.rejects(
        prepararImagensShopee(loja, ["https://exemplo.invalid/a.png"], fetcher),
        (e: Error) => e instanceof OrderError && /enviada como arquivo/.test(e.message));
    });
  });

  await t.test("o arquivo sobe com extensão no nome", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher, chamadas } = provedor(criacao);
      await prepararImagensShopee(loja, [PNG], fetcher);
      const upload = chamadas.find((c) => c.url.includes("/media_space/upload_image"))!;
      assert.deepEqual(upload.corpo, { multipart: true, nome: "imagem.png", tipo: "image/png" });
    });
  });

  await t.test("formato que a Shopee não aceita é recusado nomeando o formato", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor(criacao);
      await assert.rejects(prepararImagensShopee(loja, ["data:image/gif;base64,QUJD"], fetcher),
        (e: Error) => e instanceof OrderError && /GIF/.test(e.message));
    });
  });

  await t.test("categoria ausente é recusada antes de falar com o provedor", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor(criacao);
      await assert.rejects(
        publishShopeeListing(loja, anuncio({ categoryExternalId: null }), fetcher),
        (e: Error) => e instanceof OrderError && /aba Categoria/.test(e.message));
    });
  });

  const atualizacao = {
    "/product/update_price": { corpo: { error: "", response: {} } },
    "/product/update_stock": { corpo: { error: "", response: {} } },
    "/product/update_item": { corpo: { error: "", response: { item_status: "NORMAL" } } },
    ...criacao,
  };

  await t.test("atualização manda preço e estoque em rotas separadas", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher, chamadas } = provedor(atualizacao);
      const publicado = anuncio({
        externalListingId: "550011",
        publishedAttributes: { conteudo: "impressao-antiga", imagens: ["img-1"] },
      });
      await publishShopeeListing(loja, publicado, fetcher);

      const preco = chamadas.find((c) => c.url.includes("/product/update_price"))!;
      assert.deepEqual(preco.corpo, { item_id: 550011, price_list: [{ original_price: 79.9 }] });
      const estoque = chamadas.find((c) => c.url.includes("/product/update_stock"))!;
      assert.deepEqual(estoque.corpo,
        { item_id: 550011, stock_list: [{ seller_stock: [{ stock: 5 }] }] });
    });
  });

  await t.test("conteúdo igual não reenvia título, descrição nem imagem", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher, chamadas } = provedor(atualizacao);
      const listing = anuncio({ externalListingId: "550011" });
      // A memória do que foi publicado é o que evita recarregar o álbum a cada
      // venda -- e há uma sincronização por venda.
      const comMemoria = anuncio({
        externalListingId: "550011",
        publishedAttributes: { conteudo: impressaoDeConteudo(listing), imagens: ["img-1"] },
      });
      const resultado = await publishShopeeListing(loja, comMemoria, fetcher);

      assert.equal(chamadas.some((c) => c.url.includes("/product/update_item")), false);
      assert.equal(chamadas.some((c) => c.url.includes("/media_space/upload_image")), false,
        "reenviar imagem sem mudança gastaria upload em cada venda");
      // E a memória é preservada: devolver undefined apagaria o resumo e a
      // rodada seguinte reenviaria tudo.
      assert.deepEqual(resultado.sentAttributes,
        { conteudo: impressaoDeConteudo(listing), imagens: ["img-1"] });
    });
  });

  await t.test("conteúdo mudado reenvia o anúncio e sobe o álbum de novo", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher, chamadas } = provedor(atualizacao);
      const listing = anuncio({
        externalListingId: "550011",
        publishedAttributes: { conteudo: "outra-impressao", imagens: ["img-antiga"] },
      });
      const resultado = await publishShopeeListing(loja, listing, fetcher);

      const item = chamadas.find((c) => c.url.includes("/product/update_item"))!;
      const corpo = item.corpo as Record<string, unknown>;
      assert.equal(corpo.item_id, 550011);
      assert.equal(corpo.item_name, "Camiseta de teste");
      assert.deepEqual(corpo.image, { image_id_list: ["img-1"] });
      assert.deepEqual(resultado.sentAttributes,
        { conteudo: impressaoDeConteudo(listing), imagens: ["img-1"] });
    });
  });

  await t.test("falhar no anúncio depois de preço e estoque não perde o que passou", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor({
        ...atualizacao,
        "/product/update_item": { corpo: { error: "error_param", message: "item_name too long" } },
      });
      const listing = anuncio({
        externalListingId: "550011",
        publishedAttributes: { conteudo: "outra", imagens: [] },
      });
      await assert.rejects(publishShopeeListing(loja, listing, fetcher), (e: Error) => {
        assert.equal(e instanceof PartialPublishError, true);
        const parcial = e as PartialPublishError;
        assert.equal(parcial.resultado.externalListingId, "550011");
        assert.equal(parcial.resultado.price, "79.90");
        assert.equal(parcial.causa instanceof OrderError, true);
        return true;
      });
    });
  });

  await t.test("produto desativado vira anúncio fora do ar, não anúncio apagado", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher, chamadas } = provedor(criacao);
      await publishShopeeListing(loja, anuncio({}, { active: false }), fetcher);
      const corpo = chamadas.find((c) => c.url.includes("/product/add_item"))!
        .corpo as Record<string, unknown>;
      assert.equal(corpo.item_status, "UNLIST");
    });
  });

  await t.test("condição do catálogo vira a da Shopee", () => {
    assert.equal(condicaoShopee("novo"), "NEW");
    assert.equal(condicaoShopee("Usado - bom estado"), "USED");
    assert.equal(condicaoShopee("seminovo"), "USED");
  });
});

test("pedido da Shopee", async (t) => {
  const pedido = {
    order_sn: "2601ABCD1234", order_status: "READY_TO_SHIP",
    create_time: 1758000000, update_time: 1758003600, currency: "BRL",
    total_amount: 169.8, actual_shipping_fee: 12.5,
    buyer_username: "comprador_teste",
    recipient_address: { name: "Maria Souza" },
    item_list: [
      {
        item_id: 550011, item_name: "Camiseta", item_sku: "cam-1", model_id: 900,
        model_sku: "cam-1-m", model_quantity_purchased: 2, model_discounted_price: 79.9,
        model_original_price: 99.9,
      },
    ],
  };

  await t.test("os itens definem o bruto, e o preço é o com desconto", () => {
    const snapshot = normalizeShopeeOrder(pedido);
    // 2 x 79,90. O original_price (99,90) infla a venda e não é o que o
    // comprador pagou.
    assert.equal(snapshot.gross, "159.80");
    assert.equal(snapshot.shipping, "12.50");
    // Desconto e taxa são zero DECLARADO: o desconto já está no preço do item,
    // e a comissão da Shopee vive no escrow, que é outra chamada.
    assert.equal(snapshot.discount, "0.00");
    assert.equal(snapshot.fees, "0.00");
    assert.equal(snapshot.currency, "BRL");
  });

  await t.test("o SKU da variação vence o do item, e sobe em maiúsculas", () => {
    const snapshot = normalizeShopeeOrder(pedido);
    assert.equal(snapshot.items[0].sku, "CAM-1-M");
    assert.equal(snapshot.items[0].externalVariationId, "900");
    assert.equal(snapshot.items[0].quantity, 2);
    assert.equal(snapshot.items[0].unitPrice, "79.90");
  });

  await t.test("carimbo em segundos vira ISO, e o destinatário é o cliente", () => {
    const snapshot = normalizeShopeeOrder(pedido);
    assert.equal(snapshot.soldAt, new Date(1758000000 * 1000).toISOString());
    assert.equal(snapshot.externalUpdatedAt, new Date(1758003600 * 1000).toISOString());
    assert.equal(snapshot.customerName, "Maria Souza");
    // A Shopee mascara o e-mail: ausência é a regra, não exceção.
    assert.equal(snapshot.customerEmail, null);
  });

  await t.test("frete estimado vale enquanto o real não existe; nenhum dos dois é erro", () => {
    const semReal: Record<string, unknown> = { ...pedido };
    delete semReal.actual_shipping_fee;
    assert.equal(
      normalizeShopeeOrder({ ...semReal, estimated_shipping_fee: 9 }).shipping, "9.00");
    assert.throws(() => normalizeShopeeOrder(semReal),
      (e: Error) => e instanceof OrderError && /Frete estimado/.test(e.message),
      "frete ausente não é frete grátis");
  });

  await t.test("status mapeia, e desconhecido falha em vez de virar palpite", () => {
    assert.equal(normalizeShopeeOrder(pedido).status, "PAID");
    assert.equal(normalizeShopeeOrder({ ...pedido, order_status: "COMPLETED" }).status, "DELIVERED");
    // Cancelamento em curso já devolve estoque: esperar o fim do processo
    // deixaria de vender o que já está livre.
    assert.equal(normalizeShopeeOrder({ ...pedido, order_status: "IN_CANCEL" }).status, "CANCELLED");
    assert.throws(() => normalizeShopeeOrder({ ...pedido, order_status: "ALGO_NOVO" }),
      (e: Error) => e instanceof OrderError && /não mapeado/.test(e.message));
  });

  await t.test("pedido sem item é recusado", () => {
    assert.throws(() => normalizeShopeeOrder({ ...pedido, item_list: [] }),
      (e: Error) => e instanceof OrderError && /sem itens/.test(e.message));
  });

  await t.test("a consulta pede os campos opcionais, senão vem sem item", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher, chamadas } = provedor({
        "/order/get_order_detail": { corpo: { error: "", response: { order_list: [pedido] } } },
      });
      await fetchShopeeOrder(loja, "2601ABCD1234", fetcher);
      const url = chamadas[0].url;
      assert.equal(parametro(url, "order_sn_list"), "2601ABCD1234");
      assert.match(parametro(url, "response_optional_fields") ?? "", /item_list/);
    });
  });

  await t.test("a conciliação pagina por cursor e respeita a janela do provedor", async () => {
    await comAmbiente(ambiente, async () => {
      let pagina = 0;
      const fetcher = (async (url: string) => {
        pagina++;
        const corpo = pagina === 1
          ? {
            error: "",
            response: {
              order_list: [{ order_sn: "A", update_time: 1758000000 }],
              more: true, next_cursor: "c2",
            },
          }
          : {
            error: "",
            response: { order_list: [{ order_sn: "B", update_time: 1758000100 }], more: false },
          };
        // A janela é obrigatória nos dois lados na Shopee.
        assert.ok(new URL(url).searchParams.get("time_from"));
        assert.ok(new URL(url).searchParams.get("time_to"));
        return new Response(JSON.stringify(corpo), { status: 200 });
      }) as unknown as typeof fetch;

      const alterados = await listChangedShopeeOrders(loja, new Date(1758000000 * 1000), fetcher);
      assert.deepEqual(alterados.map((a) => a.externalOrderId), ["A", "B"]);
      assert.equal(pagina, 2);
    });
  });
});

test("aviso (push) da Shopee", async (t) => {
  await t.test("código de pedido extrai loja e identidade estável", () => {
    const aviso = parseShopeeNotification({
      code: 3, shop_id: 77001, timestamp: 1758003600,
      data: { ordersn: "2601ABCD1234", status: "READY_TO_SHIP" },
    });
    assert.equal(aviso?.orderSn, "2601ABCD1234");
    assert.equal(aviso?.shopId, "77001");
    assert.equal(aviso?.externalEventId, "shopee:3:2601ABCD1234:READY_TO_SHIP:1758003600");
  });

  await t.test("outro assunto é ignorado, não é erro", () => {
    // Devolver erro faria a Shopee reenviar para sempre algo que não nos serve.
    assert.equal(parseShopeeNotification({ code: 1, shop_id: 1, timestamp: 1 }), null);
    assert.equal(parseShopeeNotification({ code: 2, shop_id: 1, timestamp: 1 }), null);
  });

  await t.test("aviso malformado é recusado", () => {
    assert.throws(() => parseShopeeNotification({ shop_id: 1 }),
      (e: Error) => e instanceof OrderError && /sem código/.test(e.message));
    assert.throws(() => parseShopeeNotification({ code: 3, shop_id: "abc", timestamp: 1, data: {} }),
      (e: Error) => e instanceof OrderError);
  });

  await t.test("a assinatura do push é sobre o corpo CRU", () => {
    comAmbiente(ambiente, () => {
      const url = "https://omnicommerce.vercel.app/api/webhooks/shopee/abc";
      const cru = '{"code":3,"shop_id":77001}';
      const assinatura = createHmac("sha256", PARTNER_KEY).update(url + cru).digest("hex");
      assert.equal(assinaturaDePushValida(url, cru, assinatura), true);
      // Reserializar o JSON reordena chaves e muda espaços: a assinatura passa
      // a não bater por um motivo que não aparece em lugar nenhum.
      assert.equal(
        assinaturaDePushValida(url, '{ "code": 3, "shop_id": 77001 }', assinatura), false);
      assert.equal(assinaturaDePushValida(url, cru, "mentira"), false);
    });
  });
});
