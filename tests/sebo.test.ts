import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { OrderError, parseIntegratedOrder } from "../lib/domain/order-input";
import { encryptSecret } from "../lib/integrations/crypto";
import {
  ProviderAuthError, ProviderOrderGoneError, ProviderTransientError,
} from "../lib/integrations/mercadolivre/client";
import { providerResolver } from "../lib/integrations/resolve";
import { fetchSeboOrder, seboApiBase, SeboConfigurationError } from "../lib/integrations/sebo/client";

/// Configuração do canal do Sebo, como o banco a devolve. Era
/// `SEBO_API_URL` no ambiente -- uma loja para todas as organizações.
const cfgSebo = { apiUrl: "https://api-assets.sensedia.com/v1" };
import { normalizeSeboOrder } from "../lib/integrations/sebo/normalize";
import { parseSeboNotification } from "../lib/integrations/sebo/notification";

const notification = (extra: Record<string, unknown> = {}) => ({
  topic: "orders", resource: "/orders/4321", store_id: "sebo_online",
  sent: "2026-09-18T11:30:00.000-03:00", ...extra,
});

// Forma colhida de GET /integration/orders/{id} em produção (18/09/2026).
// Se o backend divergir disto, este teste é o que avisa.
const order = (extra: Record<string, unknown> = {}) => ({
  id: 4321,
  status: "PAID",
  total: 299.7,
  // O Python emite microssegundos; o Mercado Livre, milissegundos.
  created_at: "2026-09-18T10:00:00.467762+00:00",
  updated_at: "2026-09-18T11:30:00.467762+00:00",
  customer: { name: "Ana Souza", email: "ana@exemplo.test" },
  items: [{ product_id: 7, name: "Livro usado", unit_price: 99.9, quantity: 3 }],
  ...extra,
});

const connection = (extra: Record<string, unknown> = {}) => ({
  id: "conn-sebo", marketplaceId: "mkt-1", provider: "SEBO_ONLINE" as const,
  externalAccountId: "sebo_online", status: "ACTIVE" as const,
  accessToken: null, refreshToken: null, expiresAt: null, lastSyncedAt: null,
  createdAt: new Date(), updatedAt: new Date(), ...extra,
});

const context = (conn: unknown) => ({
  id: "evt-1", externalEventId: "sebo:orders:4321:x", externalOrderId: "4321",
  payload: {}, marketplaceId: "mkt-1", organizationId: "org-1", connection: conn,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;



/// Banco que só sabe responder a configuração do canal.
///
/// A URL da loja é do CANAL -- cada organização tem o seu Sebo --, então o
/// resolvedor tem de ir buscá-la. O que este dublê garante é que ele busca
/// só isso: qualquer outra tabela estoura.
const bancoComConfig = (valores: Record<string, string>) => new Proxy({
  marketplaceSetting: {
    findMany: async () => Object.entries(valores)
      .map(([key, value]) => ({ key, value, secret: false })),
  },
}, {
  get(alvo: Record<string, unknown>, chave: string) {
    if (chave in alvo) return alvo[chave];
    throw new Error(`o resolver não deveria consultar ${chave} aqui`);
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

test("adapter do Sebo On-Line sem rede e sem banco", async (t) => {
  await t.test("aviso: extrai pedido, loja e identidade estável", () => {
    const parsed = parseSeboNotification(notification());
    assert.equal(parsed.orderId, "4321");
    assert.equal(parsed.storeId, "sebo_online");
    assert.equal(parsed.externalEventId, "sebo:orders:4321:2026-09-18T11:30:00.000-03:00");
    // Reenvio do mesmo aviso mantém a identidade.
    assert.equal(parseSeboNotification(notification()).externalEventId, parsed.externalEventId);
  });

  await t.test("aviso: recusa recurso que não é pedido e campos ausentes", () => {
    for (const patch of [
      { resource: "/products/1" }, { resource: "https://api-assets.invalid/v1/orders/1" },
      { resource: "/orders/abc" }, { resource: "/orders/1/../../admin" },
      { sent: undefined }, { store_id: undefined }, { topic: undefined },
    ]) assert.throws(() => parseSeboNotification(notification(patch)), OrderError);
  });

  await t.test("base da API preserva o prefixo do gateway e exige https", () => {
    assert.equal(seboApiBase({ apiUrl: "https://api-assets.sensedia.com/v1" }), "https://api-assets.sensedia.com/v1");
    assert.equal(seboApiBase({ apiUrl: "https://api-assets.sensedia.com/v1/" }), "https://api-assets.sensedia.com/v1");
    assert.equal(seboApiBase({ apiUrl: "https://api-assets.sensedia.com" }), "https://api-assets.sensedia.com");
    for (const ruim of [undefined, "", "http://api-assets.sensedia.com/v1", "nao-e-url", "https://u:p@host/v1", "https://host/v1?x=1"]) {
      // `undefined` é o campo em branco na tela; os outros são valor inválido.
      assert.throws(() => seboApiBase({ apiUrl: ruim as string }), SeboConfigurationError);
    }
  });

  await t.test("normalização: bruto vem dos itens; frete e taxa são zero declarado", () => {
    const parsed = parseIntegratedOrder(normalizeSeboOrder(order()));
    assert.equal(parsed.externalOrderId, "4321");
    assert.equal(parsed.status, "PAID");
    assert.equal(parsed.externalStatus, "PAID");
    assert.equal(parsed.gross.toFixed(2), "299.70");
    assert.equal(parsed.shipping.toFixed(2), "0.00");
    assert.equal(parsed.fees.toFixed(2), "0.00");
    assert.equal(parsed.discount.toFixed(2), "0.00");
    assert.equal(parsed.net.toFixed(2), "299.70");
    assert.equal(parsed.customerName, "Ana Souza");
    assert.equal(parsed.externalUpdatedAt.toISOString(), "2026-09-18T11:30:00.467Z");
    assert.deepEqual(parsed.items.map((i) => [i.title, i.externalItemId, i.quantity]), [["Livro usado", "7", 3]]);
  });

  await t.test("pedido real de produção passa pela validação", () => {
    // Colhido de GET /sebo/api/integration/orders/1. Microssegundo na data
    // reprovava antes: o validador aceitava só até milissegundo.
    const real = {
      id: 1, status: "PAID", total: 219.0,
      created_at: "2026-09-17T18:52:49.467762+00:00",
      updated_at: "2026-09-17T18:52:49.467762+00:00",
      customer: { name: "Thiago Veloso", email: "thiago.vbs@gmail.com" },
      items: [{ product_id: 14, name: "Jaqueta Corta-Vento", unit_price: 219.0, quantity: 1 }],
    };
    const parsed = parseIntegratedOrder(normalizeSeboOrder(real));
    assert.equal(parsed.gross.toFixed(2), "219.00");
    assert.equal(parsed.net.toFixed(2), "219.00");
    assert.equal(parsed.status, "PAID");
  });

  await t.test("normalização: float do sebo é quantizado a duas casas", () => {
    const parsed = parseIntegratedOrder(normalizeSeboOrder(order({
      total: 29.969999999999999, items: [{ product_id: 1, name: "Item", unit_price: 9.99, quantity: 3 }],
    })));
    assert.equal(parsed.gross.toFixed(2), "29.97");
    assert.equal(parsed.discount.toFixed(2), "0.00");
  });

  await t.test("normalização: status do sebo mapeiam e desconhecido falha", () => {
    for (const [externo, esperado] of [
      ["CREATED", "CREATED"], ["AWAITING_PAYMENT", "CREATED"], ["PAID", "PAID"],
      ["CANCELLED", "CANCELLED"], ["FAILED", "CANCELLED"],
    ]) assert.equal(normalizeSeboOrder(order({ status: externo })).status, esperado);
    for (const status of ["SHIPPED", "pago", ""]) {
      assert.throws(() => normalizeSeboOrder(order({ status })), OrderError);
    }
  });

  await t.test("normalização: campo ausente é erro nomeado", () => {
    assert.throws(() => normalizeSeboOrder(order({ items: [] })), /sem itens/);
    assert.throws(() => normalizeSeboOrder(order({ total: undefined })), /Total do pedido/);
    assert.throws(() => normalizeSeboOrder(order({ updated_at: undefined })), /Data de atualização/);
    assert.throws(() => normalizeSeboOrder(order({
      items: [{ product_id: 1, name: "Item", unit_price: null, quantity: 1 }],
    })), /Preço unitário/);
    assert.throws(() => normalizeSeboOrder(order({
      items: [{ product_id: 1, name: "Item", unit_price: 1, quantity: 0 }],
    })), OrderError);
    // Total acima da soma dos itens significa mapeamento errado.
    assert.throws(() => normalizeSeboOrder(order({ total: 400 })), /precisa de revisão/);
  });

  await t.test("cliente: monta a URL sobre a base e classifica os erros", async () => {
    process.env.SEBO_API_URL = "https://api-assets.sensedia.com/v1";
    try {
      let visto: { url: string; auth: string | null } | null = null;
      const ok = async (input: RequestInfo | URL, init?: RequestInit) => {
        visto = { url: String(input), auth: new Headers(init?.headers).get("Authorization") };
        return Response.json(order());
      };
      await fetchSeboOrder(cfgSebo, "token-de-servico", "4321", ok);
      assert.equal(visto!.url, "https://api-assets.sensedia.com/v1/integration/orders/4321");
      assert.equal(visto!.auth, "Bearer token-de-servico");
      for (const ruim of ["../orders/1", "1/../admin", "abc", ""]) {
        await assert.rejects(fetchSeboOrder(cfgSebo, "t", ruim, ok), OrderError);
      }
      const status = (code: number) => async () => new Response("detalhe interno", { status: code });
      await assert.rejects(fetchSeboOrder(cfgSebo, "t", "1", status(401)), ProviderAuthError);
      await assert.rejects(fetchSeboOrder(cfgSebo, "t", "1", status(429)), ProviderTransientError);
      await assert.rejects(fetchSeboOrder(cfgSebo, "t", "1", status(502)), ProviderTransientError);
      // 404 tem classe própria: é a loja dizendo que o pedido não existe mais,
      // e o evento é ENCERRADO em vez de ficar pedindo atenção para sempre.
      await assert.rejects(
        fetchSeboOrder(cfgSebo, "t", "1", status(404)), ProviderOrderGoneError);
      // E continua sendo permanente: repetir não traz o pedido de volta.
      await assert.rejects(fetchSeboOrder(cfgSebo, "t", "1", status(404)), OrderError);
      await fetchSeboOrder(cfgSebo, "token-de-servico", "1", status(401)).catch((error: Error) => {
        assert.equal(error.message.includes("token-de-servico"), false);
      });
    } finally { delete process.env.SEBO_API_URL; }
  });

  await t.test("resolver: conexão do sebo consulta e devolve snapshot válido", async () => {
    const chave = process.env.INTEGRATION_ENCRYPTION_KEY;
    process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.SEBO_API_URL = "https://api-assets.sensedia.com/v1";
    try {
      const resolve = providerResolver(
        bancoComConfig({ apiUrl: "https://api-assets.sensedia.com/v1" }),
        async () => Response.json(order()));
      const snapshot = await resolve(context(connection({ accessToken: encryptSecret("token-de-servico") })));
      assert.equal(parseIntegratedOrder(snapshot).net.toFixed(2), "299.70");
      // As mesmas guardas do ML valem aqui.
      await assert.rejects(resolve(context(connection({ status: "INACTIVE" }))), /Conexão inativa/);
      await assert.rejects(resolve(context(connection({ accessToken: null }))), /sem credencial/);
    } finally {
      delete process.env.SEBO_API_URL;
      if (chave === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
      else process.env.INTEGRATION_ENCRYPTION_KEY = chave;
    }
  });
});
