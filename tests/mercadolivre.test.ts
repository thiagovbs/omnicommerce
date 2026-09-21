import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { OrderError, parseIntegratedOrder } from "../lib/domain/order-input";
import { decryptSecret, encryptSecret, SecretConfigurationError } from "../lib/integrations/crypto";
import { fetchOrder, ProviderAuthError, ProviderTransientError } from "../lib/integrations/mercadolivre/client";
import { normalizeMercadoLivreOrder } from "../lib/integrations/mercadolivre/normalize";
import { parseNotification } from "../lib/integrations/mercadolivre/notification";
import { providerResolver } from "../lib/integrations/resolve";

const notification = (extra: Record<string, unknown> = {}) => ({
  topic: "orders_v2", resource: "/orders/2000003508419013", user_id: 123456789,
  application_id: 987654321, attempts: 1, sent: "2026-09-18T11:30:00.000-03:00",
  received: "2026-09-18T11:30:00.100-03:00", ...extra,
});

// Fixture a substituir por um pedido real da conta autorizada: é o contrato que o
// normalizador assume, e qualquer divergência deve aparecer aqui antes de ir ao banco.
const order = (extra: Record<string, unknown> = {}) => ({
  id: 2000003508419013, status: "paid", status_detail: null,
  date_created: "2026-09-18T10:00:00.000-03:00", last_updated: "2026-09-18T11:30:00.000-03:00",
  currency_id: "BRL", total_amount: 299.7,
  order_items: [{
    item: { id: "MLB123", title: "Fone de ouvido", seller_sku: "SKU-1", variation_id: 456 },
    quantity: 3, unit_price: 99.9, full_unit_price: 99.9, sale_fee: 12.3,
  }],
  payments: [{ shipping_cost: 15.5, transaction_amount: 299.7, status: "approved" }],
  buyer: { id: 1, first_name: "Ana", last_name: "Souza", nickname: "ANASOUZA" },
  ...extra,
});

const connection = (extra: Record<string, unknown> = {}) => ({
  id: "conn-1", marketplaceId: "mkt-1", provider: "MERCADO_LIVRE" as const,
  externalAccountId: "123456789", status: "ACTIVE" as const,
  accessToken: null, refreshToken: null, expiresAt: null, lastSyncedAt: null,
  createdAt: new Date(), updatedAt: new Date(), ...extra,
});

const context = (conn: unknown) => ({
  id: "evt-1", externalEventId: "ml:orders_v2:2000003508419013:x",
  externalOrderId: "2000003508419013", payload: {}, marketplaceId: "mkt-1",
  organizationId: "org-1", connection: conn,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

// Banco que estoura se for usado: nestes casos o resolver não deve tocá-lo.
const semBanco = new Proxy({}, {
  get() { throw new Error("o resolver não deveria consultar o banco aqui"); },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

test("adapter do Mercado Livre sem rede e sem banco", async (t) => {
  await t.test("aviso: extrai pedido, vendedor e identidade estável", () => {
    const parsed = parseNotification(notification());
    assert.equal(parsed.orderId, "2000003508419013");
    assert.equal(parsed.externalAccountId, "123456789");
    assert.equal(parsed.applicationId, "987654321");
    assert.equal(parsed.externalEventId, "ml:orders_v2:2000003508419013:2026-09-18T11:30:00.000-03:00");
    // Reenvio do mesmo aviso mantém a identidade, mesmo com outra contagem de tentativas.
    assert.equal(parseNotification(notification({ attempts: 4 })).externalEventId, parsed.externalEventId);
  });

  await t.test("aviso: recusa recurso que não é pedido, campos ausentes e vendedor inválido", () => {
    for (const patch of [
      { resource: "/questions/123" }, { resource: "https://api.mercadolibre.com/orders/1" },
      { resource: "/orders/abc" }, { resource: "/orders/1/../../admin" },
      { sent: undefined }, { sent: "" }, { user_id: undefined }, { user_id: -1 }, { topic: undefined },
    ]) assert.throws(() => parseNotification(notification(patch)), OrderError);
    assert.throws(() => parseNotification("{}"), OrderError);
  });

  await t.test("normalização: bruto vem dos itens, líquido soma frete e desconta taxas", () => {
    const parsed = parseIntegratedOrder(normalizeMercadoLivreOrder(order()));
    assert.equal(parsed.externalOrderId, "2000003508419013");
    assert.equal(parsed.status, "PAID");
    assert.equal(parsed.externalStatus, "paid");
    assert.equal(parsed.gross.toFixed(2), "299.70");
    assert.equal(parsed.shipping.toFixed(2), "15.50");
    assert.equal(parsed.discount.toFixed(2), "0.00");
    assert.equal(parsed.fees.toFixed(2), "12.30");
    assert.equal(parsed.net.toFixed(2), "302.90");
    assert.equal(parsed.externalUpdatedAt.toISOString(), "2026-09-18T14:30:00.000Z");
    assert.equal(parsed.customerName, "Ana Souza");
    assert.deepEqual(parsed.items.map((item) => [item.sku, item.externalItemId, item.externalVariationId, item.quantity]),
      [["SKU-1", "MLB123", "456", 3]]);
  });

  await t.test("normalização: diferença entre itens e total do pedido vira desconto", () => {
    const parsed = parseIntegratedOrder(normalizeMercadoLivreOrder(order({ total_amount: 289.7 })));
    assert.equal(parsed.discount.toFixed(2), "10.00");
    assert.equal(parsed.net.toFixed(2), "292.90");
  });

  await t.test("normalização: frete cai para a soma dos pagamentos quando o pedido não o traz", () => {
    const parsed = parseIntegratedOrder(normalizeMercadoLivreOrder(order({
      payments: [{ shipping_cost: 10 }, { shipping_cost: 5.5 }],
    })));
    assert.equal(parsed.shipping.toFixed(2), "15.50");
    assert.equal(parseIntegratedOrder(normalizeMercadoLivreOrder(order({ shipping_cost: 7.25 }))).shipping.toFixed(2), "7.25");
  });

  await t.test("normalização: status conhecidos mapeiam e desconhecido falha em vez de adivinhar", () => {
    for (const [external, expected] of [
      ["confirmed", "CREATED"], ["payment_required", "CREATED"], ["payment_in_process", "CREATED"],
      ["partially_paid", "CREATED"], ["paid", "PAID"], ["cancelled", "CANCELLED"], ["invalid", "CANCELLED"],
    ]) assert.equal(normalizeMercadoLivreOrder(order({ status: external })).status, expected);
    // Envio não vem no recurso de pedido: não há como produzir SHIPPED/DELIVERED aqui.
    for (const status of ["shipped", "delivered", "", "PAID"]) {
      assert.throws(() => normalizeMercadoLivreOrder(order({ status })), OrderError);
    }
    assert.equal(normalizeMercadoLivreOrder(order({ status_detail: "por_comprador" })).externalStatus, "paid:por_comprador");
  });

  await t.test("normalização: valor ausente é erro nomeado, nunca zero presumido", () => {
    const items = (patch: Record<string, unknown>) => ({
      order_items: [{ ...order().order_items[0], ...patch }],
    });
    assert.throws(() => normalizeMercadoLivreOrder(order(items({ sale_fee: undefined }))), /Taxa de venda/);
    assert.throws(() => normalizeMercadoLivreOrder(order(items({ unit_price: null }))), /Preço unitário/);
    assert.throws(() => normalizeMercadoLivreOrder(order(items({ quantity: 0 }))), OrderError);
    assert.throws(() => normalizeMercadoLivreOrder(order({ payments: [{}] })), /Frete do pagamento/);
    assert.throws(() => normalizeMercadoLivreOrder(order({ payments: [] })), /Frete não informado/);
    assert.throws(() => normalizeMercadoLivreOrder(order({ total_amount: undefined })), /Total do pedido/);
    assert.throws(() => normalizeMercadoLivreOrder(order({ order_items: [] })), /sem itens/);
    // Total acima da soma dos itens significa mapeamento errado, não desconto negativo.
    assert.throws(() => normalizeMercadoLivreOrder(order({ total_amount: 400 })), /precisa de revisão/);
  });

  await t.test("cliente: host fixo, credencial no cabeçalho e erros classificados", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const ok = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), auth: new Headers(init?.headers).get("Authorization") };
      return Response.json(order());
    };
    await fetchOrder("token-secreto", "2000003508419013", ok);
    assert.equal(seen!.url, "https://api.mercadolibre.com/orders/2000003508419013");
    assert.equal(seen!.auth, "Bearer token-secreto");
    // O recurso do aviso nunca viaja como URL: só dígitos chegam ao caminho.
    for (const bad of ["../orders/1", "1/../../users", "abc", ""]) {
      await assert.rejects(fetchOrder("t", bad, ok), OrderError);
    }
    const status = (code: number) => async () => new Response("detalhe interno", { status: code });
    await assert.rejects(fetchOrder("t", "1", status(401)), ProviderAuthError);
    await assert.rejects(fetchOrder("t", "1", status(403)), ProviderAuthError);
    await assert.rejects(fetchOrder("t", "1", status(429)), ProviderTransientError);
    await assert.rejects(fetchOrder("t", "1", status(503)), ProviderTransientError);
    await assert.rejects(fetchOrder("t", "1", status(404)), OrderError);
    await assert.rejects(fetchOrder("t", "1", status(400)), OrderError);
    // Nenhuma mensagem de erro carrega o token.
    await fetchOrder("token-secreto", "1", status(401)).catch((error: Error) => {
      assert.equal(error.message.includes("token-secreto"), false);
      assert.equal(error.message.includes("detalhe interno"), false);
    });
  });

  await t.test("credenciais: ida e volta cifrada, chave errada e texto alterado falham", () => {
    const previous = process.env.INTEGRATION_ENCRYPTION_KEY;
    try {
      delete process.env.INTEGRATION_ENCRYPTION_KEY;
      assert.throws(() => encryptSecret("x"), SecretConfigurationError);
      process.env.INTEGRATION_ENCRYPTION_KEY = "chave-curta";
      assert.throws(() => encryptSecret("x"), SecretConfigurationError);
      process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
      const cipher = encryptSecret("APP_USR-token");
      assert.equal(decryptSecret(cipher), "APP_USR-token");
      assert.notEqual(cipher, "APP_USR-token");
      // Mesmo texto cifrado duas vezes não repete: o iv é sorteado por operação.
      assert.notEqual(encryptSecret("APP_USR-token"), cipher);
      const raw = Buffer.from(cipher, "base64");
      raw[raw.length - 1] ^= 0xff;
      assert.throws(() => decryptSecret(raw.toString("base64")));
      process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
      assert.throws(() => decryptSecret(cipher));
    } finally {
      if (previous === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
      else process.env.INTEGRATION_ENCRYPTION_KEY = previous;
    }
  });

  await t.test("resolver: recusa evento sem conexão utilizável antes de qualquer chamada", async () => {
    const reject = async () => { assert.fail("não deveria chamar o provedor"); };
    const resolve = providerResolver(semBanco, reject as unknown as typeof fetch);
    await assert.rejects(resolve(context(null)), /sem conexão autorizada/);
    await assert.rejects(resolve(context(connection({ status: "INACTIVE" }))), /Conexão inativa/);
    await assert.rejects(resolve(context(connection({ accessToken: null }))), /sem credencial/);
    // Com o OAuth, token vencido tenta renovar; sem credencial de renovação,
    // o pedido é reautorizar em vez de apenas "expirada".
    await assert.rejects(resolve(context(connection({
      accessToken: "cifrado", refreshToken: null, expiresAt: new Date(Date.now() - 1000),
    }))), /renovação/);
    // A OLX é o caso em que não há pedido para buscar: classificados não têm
    // pedido nenhum, e a recusa acontece antes de qualquer chamada.
    await assert.rejects(resolve(context(connection({
      provider: "OLX", accessToken: "cifrado",
    }))), /só de publicação/);
  });

  await t.test("resolver: conexão ativa consulta o provedor e devolve snapshot válido", async () => {
    const previous = process.env.INTEGRATION_ENCRYPTION_KEY;
    process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    try {
      const resolve = providerResolver(semBanco, async () => Response.json(order()));
      const snapshot = await resolve(context(connection({
        accessToken: encryptSecret("APP_USR-token"), expiresAt: new Date(Date.now() + 3600_000),
      })));
      assert.equal(parseIntegratedOrder(snapshot).net.toFixed(2), "302.90");
    } finally {
      if (previous === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
      else process.env.INTEGRATION_ENCRYPTION_KEY = previous;
    }
  });
});
