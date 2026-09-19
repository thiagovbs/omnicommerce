import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { parseIntegratedOrder } from "../lib/domain/order-input";
import { encryptSecret } from "../lib/integrations/crypto";
import { ProviderAuthError, ProviderTransientError } from "../lib/integrations/mercadolivre/client";
import {
  authorizationUrl, exchangeCode, OAuthConfigurationError, oauthConfig, refreshToken,
} from "../lib/integrations/mercadolivre/oauth";
import { criarEstado, lerEstado } from "../lib/integrations/oauth-state";
import { providerResolver } from "../lib/integrations/resolve";

const APP = "https://omnicommerce.vercel.app";

// Restaura só quando o corpo termina de verdade: com corpo assíncrono, um
// finally síncrono devolveria o ambiente antes do primeiro await retornar.
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

const configurado = {
  MERCADO_LIVRE_APP_ID: "123456",
  MERCADO_LIVRE_APP_SECRET: "segredo-da-aplicacao",
  APP_URL: APP,
  MERCADO_LIVRE_AUTH_URL: undefined,
  MERCADO_LIVRE_SCOPE: undefined,
  MERCADO_LIVRE_TOKEN_URL: undefined,
  INTEGRATION_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

const tokenBody = {
  access_token: "APP_USR-novo", refresh_token: "TG-novo", expires_in: 21600, user_id: 123456789,
};

const connection = (extra: Record<string, unknown> = {}) => ({
  id: "conn-1", marketplaceId: "mkt-1", provider: "MERCADO_LIVRE" as const,
  externalAccountId: "123456789", status: "ACTIVE" as const,
  accessToken: null, refreshToken: null, expiresAt: null, lastSyncedAt: null,
  createdAt: new Date(), updatedAt: new Date(), ...extra,
});

const context = (conn: unknown) => ({
  id: "evt-1", externalEventId: "ml:orders_v2:1:x", externalOrderId: "1",
  payload: {}, marketplaceId: "mkt-1", organizationId: "org-1", connection: conn,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

const pedidoValido = {
  id: 1, status: "paid", date_created: "2026-09-18T10:00:00.000-03:00",
  last_updated: "2026-09-18T11:30:00.000-03:00", currency_id: "BRL", total_amount: 10,
  order_items: [{ item: { id: "MLB1", title: "Item" }, quantity: 1, unit_price: 10, sale_fee: 1 }],
  payments: [{ shipping_cost: 0 }],
};

test("OAuth do Mercado Livre sem rede", async (t) => {
  await t.test("configuração ausente nomeia a variável", () => {
    comAmbiente({ ...configurado, MERCADO_LIVRE_APP_SECRET: undefined }, () => {
      assert.throws(() => oauthConfig(), /MERCADO_LIVRE_APP_SECRET/);
    });
    comAmbiente({ ...configurado, MERCADO_LIVRE_APP_ID: undefined, APP_URL: undefined }, () => {
      assert.throws(() => oauthConfig(), /MERCADO_LIVRE_APP_ID, APP_URL/);
    });
  });

  await t.test("só host do Mercado Livre é aceito como destino de autorização", () => {
    for (const ruim of [
      "https://evil.example.com/authorization",
      "http://auth.mercadolivre.com.br/authorization",
      "https://auth.mercadolivre.com.br.evil.com/x",
      "nao-e-url",
    ]) {
      comAmbiente({ ...configurado, MERCADO_LIVRE_AUTH_URL: ruim }, () => {
        assert.throws(() => oauthConfig(), OAuthConfigurationError);
      });
    }
    // Variações legítimas do domínio continuam válidas.
    for (const bom of [
      "https://auth.mercadolivre.com.br/authorization",
      "https://auth.mercadolibre.com.ar/authorization",
    ]) {
      comAmbiente({ ...configurado, MERCADO_LIVRE_AUTH_URL: bom }, () => {
        assert.equal(oauthConfig().authBase, bom);
      });
    }
  });

  await t.test("redirect_uri é derivado do APP_URL, não configurado à parte", () => {
    comAmbiente(configurado, () => {
      assert.equal(oauthConfig().redirectUri, `${APP}/api/integrations/mercadolivre/callback`);
      const url = new URL(authorizationUrl("nonce-abc"));
      assert.equal(url.origin + url.pathname, "https://auth.mercadolivre.com.br/authorization");
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("client_id"), "123456");
      assert.equal(url.searchParams.get("state"), "nonce-abc");
      assert.equal(url.searchParams.get("redirect_uri"), `${APP}/api/integrations/mercadolivre/callback`);
      // A doc do ML não manda escopo na URL: ele vem da aplicação no DevCenter.
      assert.equal(url.searchParams.has("scope"), false);
    });
  });

  await t.test("escopo só é enviado quando configurado explicitamente", () => {
    comAmbiente({ ...configurado, MERCADO_LIVRE_SCOPE: "offline_access" }, () => {
      assert.equal(new URL(authorizationUrl("n")).searchParams.get("scope"), "offline_access");
    });
    comAmbiente({ ...configurado, MERCADO_LIVRE_SCOPE: undefined }, () => {
      assert.equal(new URL(authorizationUrl("n")).searchParams.has("scope"), false);
    });
  });

  await t.test("troca do código envia formulário e devolve o vendedor", async () => {
    await comAmbiente(configurado, async () => {
      let visto: { url: string; corpo: string; tipo: string | null } | null = null;
      const tokens = await exchangeCode("TG-codigo", async (input, init) => {
        visto = {
          url: String(input),
          corpo: String(init?.body),
          tipo: new Headers(init?.headers).get("Content-Type"),
        };
        return Response.json(tokenBody);
      });
      assert.equal(visto!.url, "https://api.mercadolibre.com/oauth/token");
      assert.equal(visto!.tipo, "application/x-www-form-urlencoded");
      const enviado = new URLSearchParams(visto!.corpo);
      assert.equal(enviado.get("grant_type"), "authorization_code");
      assert.equal(enviado.get("code"), "TG-codigo");
      assert.equal(enviado.get("redirect_uri"), `${APP}/api/integrations/mercadolivre/callback`);
      assert.equal(tokens.externalAccountId, "123456789");
      assert.equal(tokens.accessToken, "APP_USR-novo");
      assert(tokens.expiresAt && tokens.expiresAt > new Date());
    });
  });

  await t.test("renovação usa grant_type de refresh", async () => {
    await comAmbiente(configurado, async () => {
      let corpo = "";
      await refreshToken("TG-antigo", async (_input, init) => {
        corpo = String(init?.body);
        return Response.json(tokenBody);
      });
      const enviado = new URLSearchParams(corpo);
      assert.equal(enviado.get("grant_type"), "refresh_token");
      assert.equal(enviado.get("refresh_token"), "TG-antigo");
    });
  });

  await t.test("resposta incompleta e erros são classificados, sem vazar segredo", async () => {
    await comAmbiente(configurado, async () => {
      // Sem user_id não há como saber de qual vendedor é a conexão.
      await assert.rejects(exchangeCode("x", async () => Response.json({ access_token: "a" })), /user_id/);
      await assert.rejects(exchangeCode("x", async () => Response.json({ user_id: 1 })), /access_token/);
      const status = (code: number) => async () => new Response("detalhe interno", { status: code });
      await assert.rejects(exchangeCode("x", status(400)), ProviderAuthError);
      await assert.rejects(exchangeCode("x", status(401)), ProviderAuthError);
      await assert.rejects(exchangeCode("x", status(429)), ProviderTransientError);
      await assert.rejects(exchangeCode("x", status(503)), ProviderTransientError);
      await exchangeCode("codigo-secreto", status(400)).catch((erro: Error) => {
        assert.equal(erro.message.includes("codigo-secreto"), false);
        assert.equal(erro.message.includes("segredo-da-aplicacao"), false);
        assert.equal(erro.message.includes("detalhe interno"), false);
      });
    });
  });

  await t.test("estado: ida e volta, nonce divergente, expirado e adulterado", () => {
    comAmbiente(configurado, () => {
      const { nonce, cookie } = criarEstado("org-1", "mkt-1");
      const estado = lerEstado(cookie, nonce);
      assert.equal(estado.organizationId, "org-1");
      assert.equal(estado.marketplaceId, "mkt-1");
      // O nonce que viaja na URL não revela organização nem canal.
      assert.equal(nonce.includes("org-1"), false);
      assert.throws(() => lerEstado(cookie, "outro-nonce"), /não corresponde/);
      assert.throws(() => lerEstado("nao-e-cifrado", nonce), /inválido/);
      const raw = Buffer.from(cookie, "base64");
      raw[raw.length - 1] ^= 0xff;
      assert.throws(() => lerEstado(raw.toString("base64"), nonce), /inválido/);
    });
  });

  await t.test("estado expirado é recusado", () => {
    comAmbiente(configurado, () => {
      const vencido = encryptSecret(JSON.stringify({
        nonce: "n1", organizationId: "org-1", marketplaceId: "mkt-1", exp: Date.now() - 1000,
      }));
      assert.throws(() => lerEstado(vencido, "n1"), /expirada/);
    });
  });

  await t.test("token expirando é renovado e gravado com compare-and-swap", async () => {
    await comAmbiente(configurado, async () => {
      const gravacoes: unknown[] = [];
      const db = {
        marketplaceConnection: {
          updateMany: async (args: { where: Record<string, unknown> }) => {
            gravacoes.push(args.where);
            return { count: 1 };
          },
          findUniqueOrThrow: async () => { assert.fail("não deveria reler: o CAS aplicou"); },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      const updatedAt = new Date("2026-09-18T12:00:00Z");
      const resolve = providerResolver(db, async (input) =>
        String(input).includes("/oauth/token")
          ? Response.json(tokenBody)
          : Response.json(pedidoValido));
      const snapshot = await resolve(context(connection({
        accessToken: encryptSecret("APP_USR-velho"),
        refreshToken: encryptSecret("TG-antigo"),
        expiresAt: new Date(Date.now() + 5000), // dentro da folga
        updatedAt,
      })));
      assert.equal(parseIntegratedOrder(snapshot).net.toFixed(2), "9.00");
      // A condição do CAS é o updatedAt lido, não só o id.
      assert.deepEqual(gravacoes, [{ id: "conn-1", updatedAt }]);
    });
  });

  await t.test("perder a corrida do CAS usa o token de quem renovou primeiro", async () => {
    await comAmbiente(configurado, async () => {
      let tokenUsado = "";
      const db = {
        marketplaceConnection: {
          updateMany: async () => ({ count: 0 }),
          findUniqueOrThrow: async () => ({ accessToken: encryptSecret("APP_USR-do-vencedor") }),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      const resolve = providerResolver(db, async (input, init) => {
        if (String(input).includes("/oauth/token")) return Response.json(tokenBody);
        tokenUsado = new Headers(init?.headers).get("Authorization") ?? "";
        return Response.json(pedidoValido);
      });
      await resolve(context(connection({
        accessToken: encryptSecret("APP_USR-velho"),
        refreshToken: encryptSecret("TG-antigo"),
        expiresAt: new Date(Date.now() - 1000),
      })));
      assert.equal(tokenUsado, "Bearer APP_USR-do-vencedor");
    });
  });

  await t.test("renovação recusada marca a conexão para reautorização", async () => {
    await comAmbiente(configurado, async () => {
      const gravado: Record<string, unknown>[] = [];
      const db = {
        marketplaceConnection: {
          updateMany: async (args: { data: Record<string, unknown> }) => {
            gravado.push(args.data);
            return { count: 1 };
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      const resolve = providerResolver(db, async () => new Response("no", { status: 400 }));
      await assert.rejects(resolve(context(connection({
        accessToken: encryptSecret("APP_USR-velho"),
        refreshToken: encryptSecret("TG-invalido"),
        expiresAt: new Date(Date.now() - 1000),
      }))), /Reautorize/);
      assert.deepEqual(gravado, [{ status: "EXPIRED" }]);
    });
  });

  await t.test("sem credencial de renovação, falha pedindo reautorização", async () => {
    await comAmbiente(configurado, async () => {
      const resolve = providerResolver(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
        async () => { assert.fail("não deveria chamar o provedor"); },
      );
      await assert.rejects(resolve(context(connection({
        accessToken: encryptSecret("APP_USR-velho"),
        refreshToken: null,
        expiresAt: new Date(Date.now() - 1000),
      }))), /renovação/);
    });
  });
});
