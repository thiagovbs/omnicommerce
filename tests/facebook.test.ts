import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { OrderError } from "../lib/domain/order-input";
import { facebookItemPayload, publishFacebookItem } from "../lib/integrations/facebook/catalog";
import {
  consultarLoteFacebook, enviarItensFacebook, facebookApiVersion, facebookCatalogId,
  facebookGraphBase,
} from "../lib/integrations/facebook/client";
import {
  exchangeFacebookCode, facebookAuthorizationUrl, facebookOauthConfig, facebookOauthConfigured,
  fetchFacebookAccount,
} from "../lib/integrations/facebook/oauth";
import { ProviderAuthError, ProviderTransientError } from "../lib/integrations/mercadolivre/client";
import { providerLister } from "../lib/integrations/reconcile";
import { providerResolver } from "../lib/integrations/resolve";
import type { ListingWithProduct } from "../lib/services/listings";

/// Nenhuma chamada deste arquivo deve alcançar o banco.
const semBanco = null as unknown as import("@prisma/client").PrismaClient;

// No ambiente sobra o que é da INSTALAÇÃO: o endereço público deste deploy.
// As credenciais da Meta são do canal, e chegam como objeto.
const ambiente = { APP_URL: "https://omnicommerce.vercel.app" };

/// Configuração do canal, como o banco a devolve.
const cfgFb: Record<string, string> = {
  appId: "app-meta",
  appSecret: "segredo-meta",
  catalogId: "1234567890",
  productUrlBase: "https://sualoja.com.br/p",
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

const IMAGEM = "https://exemplo.invalid/camiseta.jpg";

function anuncio(over: Partial<ListingWithProduct> = {}, produtoOver = {}): ListingWithProduct {
  const produto = {
    id: "p1", organizationId: "o1", sku: "CAM-1", title: "Camiseta de teste",
    description: "Malha de algodão, tamanho M.", category: "", brand: "Omnicommerce",
    condition: "novo", price: new Prisma.Decimal("79.90"), currency: "BRL", stock: 5,
    active: true, createdAt: new Date(), updatedAt: new Date(),
    images: [{ id: "i1", productId: "p1", position: 0, url: IMAGEM, createdAt: new Date() }],
    ...produtoOver,
  };
  return {
    id: "listing-1", productId: "p1", marketplaceId: "m1", connectionId: "c1",
    status: "PUBLISHING", externalListingId: null, publishedPrice: null, publishedStock: null,
    publishedFingerprint: null, categoryExternalId: null, publishedCategoryId: null,
    publishedAttributes: null, attributes: null, lastPublishedAt: null, externalStatus: null,
    needsSync: true, availableAt: new Date(), attempts: 0, lastError: null,
    leaseUntil: null, leaseToken: null, createdAt: new Date(), updatedAt: new Date(),
    product: produto,
    ...over,
  } as unknown as ListingWithProduct;
}

function provedor(rotas: Record<string, { status?: number; corpo: unknown }>) {
  const chamadas: { url: string; metodo: string; corpo: unknown; auth: string | null }[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const metodo = init.method ?? "GET";
    let enviado: unknown = null;
    if (init.body instanceof URLSearchParams) enviado = Object.fromEntries(init.body);
    else if (typeof init.body === "string") {
      try { enviado = JSON.parse(init.body); } catch { enviado = init.body; }
    }
    const cabecalhos = (init.headers ?? {}) as Record<string, string>;
    chamadas.push({ url, metodo, corpo: enviado, auth: cabecalhos.Authorization ?? null });
    const chave = Object.keys(rotas).find((r) => url.includes(r));
    if (!chave) return new Response("{}", { status: 404 });
    const rota = rotas[chave];
    return new Response(JSON.stringify(rota.corpo), {
      status: rota.status ?? 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, chamadas };
}

const conexao = (extra: Record<string, unknown> = {}) => ({
  id: "conn-1", marketplaceId: "mkt-1", provider: "FACEBOOK" as const,
  externalAccountId: "10001", status: "ACTIVE" as const,
  accessToken: null, refreshToken: null, expiresAt: null, lastSyncedAt: null,
  lastReconciledAt: null, createdAt: new Date(), updatedAt: new Date(), ...extra,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

test("Configuração do canal do Facebook", async (t) => {
  await t.test("a versão entra no caminho e é conferida", () => {
    assert.equal(facebookApiVersion({}), "v23.0");
    assert.equal(facebookGraphBase(cfgFb), "https://graph.facebook.com/v23.0");
    assert.equal(facebookApiVersion({ apiVersion: "v25.0" }), "v25.0");
    // Versão inventada responderia erro em TODA chamada; recusar aqui nomeia
    // o formato.
    assert.throws(() => facebookApiVersion({ apiVersion: "23" }), /v23\.0/);
  });

  await t.test("host fora da Meta é recusado", () => {
    // Configuração errada não pode mandar o token do catálogo para host qualquer.
    assert.throws(
      () => facebookGraphBase({ ...cfgFb, graphUrl: "https://evil.example.com" }),
      /domínio da Meta/);
  });

  await t.test("o id do catálogo é numérico", () => {
    assert.equal(facebookCatalogId(cfgFb), "1234567890");
    assert.throws(() => facebookCatalogId({ catalogId: "123/items" }), /ID do catálogo/);
    assert.throws(() => facebookCatalogId({}), /ID do catálogo/);
  });
});

test("OAuth do Facebook", async (t) => {
  await t.test("a URL leva app, escopo e state, e o retorno é fixo", () => {
    comAmbiente(ambiente, () => {
      const url = new URL(facebookAuthorizationUrl(cfgFb, "nonce-1"));
      assert.equal(url.origin + url.pathname, "https://www.facebook.com/v23.0/dialog/oauth");
      assert.equal(url.searchParams.get("client_id"), "app-meta");
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("state"), "nonce-1");
      assert.equal(
        url.searchParams.get("redirect_uri"),
        "https://omnicommerce.vercel.app/api/integrations/facebook/callback");
      assert.equal(url.searchParams.get("scope"), "catalog_management,business_management");
    });
  });

  await t.test("configuração ausente é nomeada pelo campo da tela", () => {
    comAmbiente(ambiente, () => {
      assert.equal(facebookOauthConfigured({ ...cfgFb, appId: "" }), false);
      assert.throws(() => facebookOauthConfig({ ...cfgFb, appId: "" }), /App ID/);
      // Sem catálogo a conexão nasceria sem ter onde escrever.
      assert.throws(() => facebookOauthConfig({ ...cfgFb, catalogId: "" }), /ID do catálogo/);
    });
  });

  await t.test("a troca do código já devolve o token longo", async () => {
    await comAmbiente(ambiente, async () => {
      const respostas = [
        { access_token: "curto", expires_in: "3600", scope: "catalog_management" },
        { access_token: "longo", token_type: "bearer", expires_in: 5184000 },
      ];
      let i = 0;
      const chamadas: string[] = [];
      const fetcher = (async (url: string) => {
        chamadas.push(url);
        return new Response(JSON.stringify(respostas[i++]), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const tokens = await exchangeFacebookCode(cfgFb, "codigo", fetcher);
      // O curto vale uma hora e não pode ser trocado depois de vencer: a
      // segunda ida acontece agora, e é o token dela que fica guardado.
      assert.equal(chamadas.length, 2);
      assert.equal(new URL(chamadas[1]).searchParams.get("grant_type"), "fb_exchange_token");
      assert.equal(new URL(chamadas[1]).searchParams.get("fb_exchange_token"), "curto");
      assert.equal(tokens.accessToken, "longo");
      // Não há refresh token na Meta: quando vence, a pessoa autoriza de novo.
      assert.equal(tokens.refreshToken, null);
      assert.ok(tokens.expiresAt && tokens.expiresAt.getTime() > Date.now() + 5_000_000_000);
      // O escopo só vem na primeira resposta, e é preservado para a conferência.
      assert.equal(tokens.escopoConcedido, "catalog_management");
    });
  });

  await t.test("validade ausente não é inventada", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor({ "/oauth/access_token": { corpo: { access_token: "t" } } });
      const tokens = await exchangeFacebookCode(cfgFb, "codigo", fetcher);
      // Nulo significa "sem vencimento conhecido": inventar um prazo curto
      // reautorizaria sem motivo, e um longo falharia calado.
      assert.equal(tokens.expiresAt, null);
    });
  });

  await t.test("recusa e indisponibilidade viram classes diferentes", async () => {
    await comAmbiente(ambiente, async () => {
      const recusa = provedor({ "/oauth/access_token": { status: 400, corpo: { error: {} } } });
      await assert.rejects(() => exchangeFacebookCode(cfgFb, "c", recusa.fetcher), ProviderAuthError);
      const fora = provedor({ "/oauth/access_token": { status: 503, corpo: {} } });
      await assert.rejects(() => exchangeFacebookCode(cfgFb, "c", fora.fetcher), ProviderTransientError);
    });
  });

  await t.test("autorização sem o escopo do catálogo é recusada na hora", async () => {
    const { fetcher, chamadas } = provedor({ "/me": { corpo: { id: "10001", name: "Loja" } } });
    await assert.rejects(
      () => fetchFacebookAccount(
        cfgFb, { accessToken: "t", refreshToken: null, expiresAt: null, campos: [],
          escopoConcedido: "business_management" }, fetcher),
      /catalog_management/);
    // Recusou ANTES de perguntar quem é: a falha na publicação apareceria dias
    // depois, por anúncio, sem ligação visível com a causa.
    assert.equal(chamadas.length, 0);
  });

  await t.test("a conta autorizada é identificada", async () => {
    const { fetcher, chamadas } = provedor({ "/me": { corpo: { id: 10001, name: "Loja" } } });
    const conta = await fetchFacebookAccount(
      cfgFb, { accessToken: "token-longo", refreshToken: null, expiresAt: null, campos: [],
        escopoConcedido: "catalog_management,business_management" }, fetcher);
    assert.deepEqual(conta, { externalAccountId: "10001", nome: "Loja" });
    assert.equal(chamadas[0].auth, "Bearer token-longo");
  });
});

test("Item do catálogo do Facebook", async (t) => {
  await t.test("o corpo tem a forma que a Meta exige", () => {
    const item = facebookItemPayload(cfgFb, anuncio());
    // UPDATE, e não CREATE: com `allow_upsert` ele cria o que não existe e
    // edita o que existe, que é o que o estado desejado pede.
    assert.equal(item.method, "UPDATE");
    assert.deepEqual(item.data, {
      // O identificador é o SKU: é por ele que a Meta casa o item, e é o que o
      // catálogo do cliente já usa.
      id: "CAM-1",
      title: "Camiseta de teste",
      description: "Malha de algodão, tamanho M.",
      // Valor, espaço e código ISO de três letras.
      price: "79.90 BRL",
      availability: "in stock",
      quantity_to_sell_on_facebook: 5,
      condition: "new",
      brand: "Omnicommerce",
      // A Meta exige link e o produto não tem: ele vem da base do canal.
      link: "https://sualoja.com.br/p/CAM-1",
      image: [{ url: IMAGEM }],
    });
  });

  await t.test("estoque zero esgota o item; produto desativado o remove", () => {
    const esgotado = facebookItemPayload(cfgFb, anuncio({}, { stock: 0 }));
    // Esgotado continua no catálogo: apagar perderia histórico e anúncios.
    assert.equal(esgotado.method, "UPDATE");
    assert.deepEqual(
      [esgotado.data.availability, esgotado.data.quantity_to_sell_on_facebook],
      ["out of stock", 0]);

    const removido = facebookItemPayload(cfgFb, anuncio({}, { active: false }));
    assert.equal(removido.method, "DELETE");
    // O DELETE leva só o id: descrever um item que está saindo não faz sentido.
    assert.deepEqual(removido.data, { id: "CAM-1" });
  });

  await t.test("a condição do produto é traduzida, e o que não traduz é recusado", () => {
    const usado = facebookItemPayload(cfgFb, anuncio({}, { condition: "Usado" }));
    assert.equal(usado.data.condition, "used");
    const recondicionado = facebookItemPayload(cfgFb, anuncio({}, { condition: "recondicionado" }));
    assert.equal(recondicionado.data.condition, "refurbished");
    // Sem condição cadastrada o item é novo: recusar travaria todo catálogo
    // que não preenche o campo.
    assert.equal(facebookItemPayload(cfgFb, anuncio({}, { condition: "" })).data.condition, "new");
    assert.throws(
      () => facebookItemPayload(cfgFb, anuncio({}, { condition: "quebrado" })),
      /novo, usado ou recondicionado/);
  });

  await t.test("o que falta é nomeado onde se corrige", () => {
    // A recusa da Meta viria como validação genérica do item; aqui cada
    // mensagem diz qual campo de qual tela preencher.
    assert.throws(() => facebookItemPayload(cfgFb, anuncio({}, { description: "" })), /descrição/);
    assert.throws(() => facebookItemPayload(cfgFb, anuncio({}, { brand: "" })), /marca/);
    assert.throws(() => facebookItemPayload(cfgFb, anuncio({}, { sku: "" })), /SKU/);
    assert.throws(
      () => facebookItemPayload({ ...cfgFb, productUrlBase: "" }, anuncio()),
      /endereço base do produto/);
    // A Meta busca a imagem pelo endereço: arquivo embutido não tem como ser
    // lido por ela.
    assert.throws(
      () => facebookItemPayload(cfgFb, anuncio({}, {
        images: [{ id: "i1", productId: "p1", position: 0, url: "data:image/png;base64,AAA", createdAt: new Date() }],
      })),
      /não aceita arquivo embutido/);
    assert.throws(() => facebookItemPayload(cfgFb, anuncio({}, { images: [] })), /ao menos uma imagem/);
  });
});

test("Publicação no catálogo do Facebook", async (t) => {
  await t.test("envia o lote, consulta o destino e registra o que foi enviado", async () => {
    const { fetcher, chamadas } = provedor({
      "/items_batch": { corpo: { handles: ["h-1"], validation_status: [] } },
      "/check_batch_request_status": {
        corpo: { data: [{ status: "finished", errors: [], warnings: [{ message: "sem GTIN" }] }] },
      },
    });
    const resultado = await publishFacebookItem(cfgFb, "token-longo", anuncio(), fetcher);

    const envio = chamadas[0];
    assert.equal(envio.metodo, "POST");
    assert.ok(envio.url.startsWith("https://graph.facebook.com/v23.0/1234567890/items_batch"));
    // O token vai no cabeçalho: query aparece em log de servidor e de proxy, e
    // este token escreve no catálogo.
    assert.equal(envio.auth, "Bearer token-longo");
    const corpo = envio.corpo as Record<string, string>;
    assert.equal(corpo.item_type, "PRODUCT_ITEM");
    // Explícito, embora seja o padrão da Meta: é o que faz o UPDATE criar.
    assert.equal(corpo.allow_upsert, "true");
    assert.equal(JSON.parse(corpo.requests)[0].data.id, "CAM-1");

    assert.equal(resultado.externalListingId, "CAM-1");
    assert.equal(resultado.price, "79.90");
    assert.equal(resultado.stock, 5);
    assert.equal(resultado.externalStatus, "finished");
    // O aviso (não erro) fica registrado sem derrubar a publicação.
    assert.deepEqual(
      (resultado.sentAttributes as { mensagens: string[]; handle: string }),
      { catalogo: "1234567890", handle: "h-1", status: "finished", mensagens: ["sem GTIN"] } as never);
  });

  await t.test("recusa na validação vira falha, com o motivo da Meta", async () => {
    const { fetcher } = provedor({
      "/items_batch": {
        corpo: {
          handles: [],
          validation_status: [{ retailer_id: "CAM-1", errors: [{ message: "price inválido" }] }],
        },
      },
    });
    // Sem isto o item ficaria marcado como publicado tendo sido rejeitado.
    await assert.rejects(
      () => publishFacebookItem(cfgFb, "t", anuncio(), fetcher),
      (e: unknown) => e instanceof OrderError && /price inválido/.test((e as Error).message));
  });

  await t.test("lote sem handle é falha: nada foi ingerido", async () => {
    const { fetcher } = provedor({ "/items_batch": { corpo: { handles: [], validation_status: [] } } });
    await assert.rejects(
      () => publishFacebookItem(cfgFb, "t", anuncio(), fetcher), /não ingeriu/);
  });

  await t.test("falha na CONSULTA não derruba o item que a Meta já aceitou", async () => {
    const { fetcher } = provedor({
      "/items_batch": { corpo: { handles: ["h-2"], validation_status: [] } },
      "/check_batch_request_status": { status: 500, corpo: {} },
    });
    const resultado = await publishFacebookItem(cfgFb, "t", anuncio(), fetcher);
    // O envio é o que importa; a consulta é diagnóstico. O handle fica
    // registrado, e é por ele que se descobre o destino depois.
    assert.equal(resultado.externalStatus, "queued");
    assert.equal((resultado.sentAttributes as { handle: string }).handle, "h-2");
  });

  await t.test("erro que aparece só na consulta também derruba", async () => {
    const { fetcher } = provedor({
      "/items_batch": { corpo: { handles: ["h-3"], validation_status: [] } },
      "/check_batch_request_status": {
        corpo: { data: [{ status: "finished", errors: [{ message: "imagem inacessível" }] }] },
      },
    });
    await assert.rejects(
      () => publishFacebookItem(cfgFb, "t", anuncio(), fetcher), /imagem inacessível/);
  });

  await t.test("erro da Graph API é classificado pelo código, e não pelo status", async () => {
    // A Meta responde 400 em quase tudo -- inclusive em token e em excesso de
    // chamadas -- então o status sozinho não separa "tentar de novo" de
    // "corrigir o cadastro".
    const token = provedor({ "/items_batch": { status: 400, corpo: { error: { code: 190, message: "expirado" } } } });
    await assert.rejects(
      () => enviarItensFacebook(cfgFb, "t", [{}], token.fetcher), ProviderAuthError);

    const limite = provedor({ "/items_batch": { status: 400, corpo: { error: { code: 4, message: "limite" } } } });
    await assert.rejects(
      () => enviarItensFacebook(cfgFb, "t", [{}], limite.fetcher), ProviderTransientError);

    const dado = provedor({
      "/items_batch": { status: 400, corpo: { error: { code: 100, error_user_msg: "campo brand ausente" } } },
    });
    await assert.rejects(
      () => enviarItensFacebook(cfgFb, "t", [{}], dado.fetcher),
      (e: unknown) => e instanceof OrderError && /campo brand ausente/.test((e as Error).message));
  });

  await t.test("erro dentro de 200 também é erro", async () => {
    const { fetcher } = provedor({
      "/check_batch_request_status": { status: 200, corpo: { error: { code: 190 } } },
    });
    await assert.rejects(
      () => consultarLoteFacebook(cfgFb, "t", "h", fetcher), ProviderAuthError);
  });
});

test("O Facebook é canal só de publicação", async (t) => {
  await t.test("pedido e conciliação recusam com a frase, e não com 'não implementado'", async () => {
    const resolver = providerResolver(semBanco);
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => resolver({ connection: conexao({ accessToken: "x" }), externalOrderId: "1" } as any),
      /só de publicação/);
    await assert.rejects(
      () => providerLister(semBanco)(conexao({ accessToken: "x" }), new Date()),
      /só de publicação/);
  });
});
