import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { OrderError } from "../lib/domain/order-input";
import { ProviderAuthError, ProviderTransientError } from "../lib/integrations/mercadolivre/client";
import { consultarImportacaoOlx, importarAnunciosOlx, olxApiBase } from "../lib/integrations/olx/client";
import { olxAdPayload, publishOlxAd } from "../lib/integrations/olx/catalog";
import {
  exchangeOlxCode, fetchOlxUserInfo, olxAuthorizationUrl, olxOauthConfig, olxOauthConfigured,
} from "../lib/integrations/olx/oauth";
import { providerLister } from "../lib/integrations/reconcile";
import { providerResolver } from "../lib/integrations/resolve";
import type { ListingWithProduct } from "../lib/services/listings";

/// Nenhuma chamada deste arquivo deve alcançar o banco.
const semBanco = null as unknown as import("@prisma/client").PrismaClient;

// No ambiente sobra o que é da INSTALAÇÃO: o endereço público deste deploy.
// As credenciais da OLX são do canal, e chegam como objeto.
const ambiente = {
  APP_URL: "https://omnicommerce.vercel.app",
};

/// Configuração do canal da OLX, como o banco a devolve.
const cfgOlx: Record<string, string> = {
  clientId: "cliente-olx",
  clientSecret: "segredo-olx",
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

/// Telefone e CEP vêm do cadastro da organização (tela de Organizações), e não
/// do ambiente: o mesmo deploy atende vários tenants, e um valor de ambiente
/// faria o anúncio de um sair com o telefone do outro.
const ANUNCIANTE = { telefone: "11988887777", cep: "01001000" };

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
    publishedFingerprint: null, categoryExternalId: "1020", publishedCategoryId: null,
    publishedAttributes: null, attributes: null, lastPublishedAt: null, externalStatus: null,
    needsSync: true, availableAt: new Date(), attempts: 0, lastError: null,
    leaseUntil: null, leaseToken: null, createdAt: new Date(), updatedAt: new Date(),
    product: produto,
    ...over,
  } as unknown as ListingWithProduct;
}

function provedor(rotas: Record<string, { status?: number; corpo: unknown }>) {
  const chamadas: { url: string; metodo: string; corpo: unknown }[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const metodo = init.method ?? "GET";
    let enviado: unknown = null;
    if (typeof init.body === "string") {
      try { enviado = JSON.parse(init.body); } catch { enviado = init.body; }
    } else if (init.body instanceof URLSearchParams) {
      enviado = Object.fromEntries(init.body);
    }
    chamadas.push({ url, metodo, corpo: enviado });
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
  id: "conn-1", marketplaceId: "mkt-1", provider: "OLX" as const,
  externalAccountId: "anunciante@exemplo.invalid", status: "ACTIVE" as const,
  accessToken: null, refreshToken: null, expiresAt: null, lastSyncedAt: null,
  lastReconciledAt: null, createdAt: new Date(), updatedAt: new Date(), ...extra,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

test("OAuth da OLX", async (t) => {
  await t.test("a URL leva client_id, escopo e state, e o retorno é fixo", () => {
    comAmbiente(ambiente, () => {
      const url = new URL(olxAuthorizationUrl(cfgOlx, "nonce-1"));
      assert.equal(url.origin + url.pathname, "https://auth.olx.com.br/oauth");
      assert.equal(url.searchParams.get("client_id"), "cliente-olx");
      assert.equal(url.searchParams.get("response_type"), "code");
      // O nonce vai em `state`: a OLX cadastra as URIs de retorno uma a uma e
      // valida a URI inteira, então caminho variável não casaria com nenhuma.
      assert.equal(url.searchParams.get("state"), "nonce-1");
      assert.equal(
        url.searchParams.get("redirect_uri"),
        "https://omnicommerce.vercel.app/api/integrations/olx/callback");
      // Só o que a publicação precisa: escopo a mais pede ao anunciante uma
      // permissão que não vamos usar.
      assert.equal(url.searchParams.get("scope"), "basic_user_info autoupload");
    });
  });

  await t.test("configuração ausente é nomeada, e host fora da OLX é recusado", () => {
    comAmbiente(ambiente, () => {
      assert.equal(olxOauthConfigured({ ...cfgOlx, clientId: "" }), false);
      // Nomeia o CAMPO da tela, não a variável de ambiente.
      assert.throws(() => olxOauthConfig({ ...cfgOlx, clientId: "" }), /Client ID/);
    });
    comAmbiente(ambiente, () => {
      // Configuração errada não pode virar redirecionamento para host qualquer.
      assert.throws(
        () => olxOauthConfig({ ...cfgOlx, authUrl: "https://evil.example.com" }),
        /domínio da OLX/);
    });
  });

  await t.test("a troca do código não inventa validade que o provedor não deu", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher, chamadas } = provedor({
        "/oauth/token": { corpo: { access_token: "token-olx", scope: "autoupload" } },
      });
      const tokens = await exchangeOlxCode(cfgOlx, "codigo", fetcher);
      assert.equal(tokens.accessToken, "token-olx");
      // A OLX não documenta validade nem refresh. Nulo é "sem vencimento
      // conhecido"; um prazo inventado reautorizaria sem motivo ou falharia calado.
      assert.equal(tokens.expiresAt, null);
      assert.equal(tokens.refreshToken, null);
      assert.deepEqual(chamadas[0].corpo, {
        grant_type: "authorization_code",
        client_id: "cliente-olx",
        client_secret: "segredo-olx",
        code: "codigo",
        redirect_uri: "https://omnicommerce.vercel.app/api/integrations/olx/callback",
      });
    });
  });

  await t.test("recusa e indisponibilidade são classificadas", async () => {
    await comAmbiente(ambiente, async () => {
      const recusa = provedor({ "/oauth/token": { status: 400, corpo: {} } });
      await assert.rejects(exchangeOlxCode(cfgOlx, "x", recusa.fetcher),
        (e: Error) => e instanceof ProviderAuthError);
      const fora = provedor({ "/oauth/token": { status: 503, corpo: {} } });
      await assert.rejects(exchangeOlxCode(cfgOlx, "x", fora.fetcher),
        (e: Error) => e instanceof ProviderTransientError);
    });
  });

  await t.test("a conta é identificada por basic_user_info, porque o token não a traz", async () => {
    await comAmbiente(ambiente, async () => {
      const comId = provedor({
        "/basic_user_info": { corpo: { user_id: 998877, name: "Loja Teste", email: "A@Exemplo.Invalid" } },
      });
      const conta = await fetchOlxUserInfo(cfgOlx, "token", comId.fetcher);
      // O id vem primeiro: e-mail o anunciante pode trocar.
      assert.equal(conta.externalAccountId, "998877");
      assert.equal(conta.email, "a@exemplo.invalid");

      const soEmail = provedor({ "/basic_user_info": { corpo: { email: "b@exemplo.invalid" } } });
      assert.equal((await fetchOlxUserInfo(cfgOlx, "token", soEmail.fetcher)).externalAccountId,
        "b@exemplo.invalid");
    });
  });

  await t.test("sem identificar a conta, a autorização falha dizendo onde corrigir", async () => {
    await comAmbiente(ambiente, async () => {
      const semNada = provedor({ "/basic_user_info": { corpo: {} } });
      await assert.rejects(fetchOlxUserInfo(cfgOlx, "token", semNada.fetcher),
        (e: Error) => e instanceof OrderError && /identificador nem e-mail/.test(e.message));

      const caminhoErrado = provedor({ "/nada": { corpo: {} } });
      await assert.rejects(fetchOlxUserInfo(cfgOlx, "token", caminhoErrado.fetcher),
        (e: Error) => e instanceof OrderError && /OLX_USER_INFO_PATH/.test(e.message));
    });
  });
});

test("corpo do anúncio da OLX", async (t) => {
  await t.test("as chaves são as do contrato, com as maiúsculas dele", () => {
    comAmbiente(ambiente, () => {
      const corpo = olxAdPayload(anuncio(), ANUNCIANTE);
      assert.deepEqual(Object.keys(corpo).sort(), [
        "Body", "Phone", "Subject", "category", "id", "images", "operation",
        "phone_hidden", "price", "type", "zipcode",
      ]);
      // O id é NOSSO: a OLX casa a importação por ele, e reenviar o mesmo id é
      // edição, não anúncio novo.
      assert.equal(corpo.id, "listing-1");
      assert.equal(corpo.operation, "insert");
      assert.equal(corpo.category, 1020);
      assert.equal(corpo.Subject, "Camiseta de teste");
      assert.equal(corpo.Body, "Malha de algodão, tamanho M.");
      assert.equal(corpo.type, "s");
      assert.deepEqual(corpo.images, [IMAGEM]);
    });
  });

  await t.test("telefone e CEP vêm da organização, só com dígitos", () => {
    comAmbiente(ambiente, () => {
      const corpo = olxAdPayload(anuncio(), ANUNCIANTE);
      assert.equal(corpo.Phone, 11988887777);
      assert.equal(corpo.zipcode, "01001000");
    });
  });

  await t.test("cadastro incompleto manda completar a organização", () => {
    comAmbiente(ambiente, () => {
      // A recusa do provedor falaria de campo inválido, sem dizer que o dado
      // que falta é o da empresa, noutra tela.
      for (const incompleto of [
        { telefone: "", cep: "01001000" },
        { telefone: "11988887777", cep: "" },
        { telefone: "119", cep: "01001000" },
        { telefone: "11988887777", cep: "123" },
      ]) {
        assert.throws(
          () => olxAdPayload(anuncio(), incompleto),
          (e: Error) => e instanceof OrderError && /Organizações/.test(e.message));
      }
    });
  });

  await t.test("o preço é inteiro em reais, e o arredondamento é declarado", () => {
    comAmbiente(ambiente, () => {
      // R$ 79,90 anuncia R$ 80: o contrato não aceita centavos.
      assert.equal(olxAdPayload(anuncio(), ANUNCIANTE).price, 80);
      assert.equal(olxAdPayload(anuncio({}, { price: new Prisma.Decimal("12.10") }), ANUNCIANTE).price, 12);
      assert.throws(
        () => olxAdPayload(anuncio({}, { price: new Prisma.Decimal("0.40") }), ANUNCIANTE),
        (e: Error) => e instanceof OrderError && /a partir de R\$ 1/.test(e.message));
    });
  });

  await t.test("produto desativado vira delete, que é como se despublica aqui", () => {
    comAmbiente(ambiente, () => {
      assert.equal(olxAdPayload(anuncio({}, { active: false }), ANUNCIANTE).operation, "delete");
    });
  });

  await t.test("imagem embutida é recusada: a OLX busca pelo endereço", () => {
    comAmbiente(ambiente, () => {
      assert.throws(
        () => olxAdPayload(anuncio({}, {
          images: [{ id: "i1", productId: "p1", position: 0, url: "data:image/png;base64,QUJD", createdAt: new Date() }],
        }), ANUNCIANTE),
        (e: Error) => e instanceof OrderError && /não aceita arquivo embutido/.test(e.message));
    });
  });

  await t.test("descrição e categoria ausentes são recusadas nomeando o campo", () => {
    comAmbiente(ambiente, () => {
      assert.throws(() => olxAdPayload(anuncio({}, { description: "  " }), ANUNCIANTE),
        (e: Error) => e instanceof OrderError && /exige descrição/.test(e.message));
      assert.throws(() => olxAdPayload(anuncio({ categoryExternalId: null }), ANUNCIANTE),
        (e: Error) => e instanceof OrderError && /código numérico da categoria/.test(e.message));
    });
  });

  await t.test("o álbum é cortado no teto da OLX", () => {
    comAmbiente(ambiente, () => {
      const muitas = Array.from({ length: 25 }, (_, i) => ({
        id: `i${i}`, productId: "p1", position: i, url: `${IMAGEM}?n=${i}`, createdAt: new Date(),
      }));
      assert.equal((olxAdPayload(anuncio({}, { images: muitas }), ANUNCIANTE).images as string[]).length, 20);
    });
  });

  await t.test("a base da API só aceita https e preserva o prefixo", () => {
    comAmbiente(ambiente, () => {
      assert.equal(olxApiBase(cfgOlx), "https://apps.olx.com.br");
    });
    comAmbiente(ambiente, () => {
      assert.throws(
        () => olxApiBase({ ...cfgOlx, apiUrl: "http://apps.olx.com.br" }),
        /URL da API da OLX inválida/);
    });
  });
});

test("importação de anúncio na OLX", async (t) => {
  const importacaoOk = { "/autoupload/import": { corpo: { token: "imp-1", statusCode: 0 } } };

  await t.test("o envio é PUT com access_token e ad_list no corpo", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher, chamadas } = provedor(importacaoOk);
      const resultado = await importarAnunciosOlx(cfgOlx, "token-olx", [{ id: "a" }], fetcher);
      assert.equal(resultado.token, "imp-1");
      assert.equal(chamadas[0].metodo, "PUT");
      assert.deepEqual(chamadas[0].corpo, { access_token: "token-olx", ad_list: [{ id: "a" }] });
    });
  });

  await t.test("statusCode negativo vira mensagem própria por código", async () => {
    await comAmbiente(ambiente, async () => {
      const semPermissao = provedor({
        "/autoupload/import": { corpo: { statusCode: -6, statusMessage: "sem permissao" } },
      });
      await assert.rejects(importarAnunciosOlx(cfgOlx, "t", [{}], semPermissao.fetcher),
        (e: Error) => e instanceof OrderError && /plano contratado/.test(e.message));

      const semVaga = provedor({ "/autoupload/import": { corpo: { statusCode: -7 } } });
      await assert.rejects(importarAnunciosOlx(cfgOlx, "t", [{}], semVaga.fetcher),
        (e: Error) => e instanceof OrderError && /vagas suficientes/.test(e.message));

      const invalido = provedor({
        "/autoupload/import": { corpo: { statusCode: -4, errors: ["CATEGORY_INVALID"] } },
      });
      await assert.rejects(importarAnunciosOlx(cfgOlx, "t", [{}], invalido.fetcher),
        (e: Error) => e instanceof OrderError && /CATEGORY_INVALID/.test(e.message));
    });
  });

  await t.test("bloqueio por excesso e serviço fora são temporários", async () => {
    await comAmbiente(ambiente, async () => {
      for (const codigo of [-2, -5]) {
        const { fetcher } = provedor({ "/autoupload/import": { corpo: { statusCode: codigo } } });
        await assert.rejects(importarAnunciosOlx(cfgOlx, "t", [{}], fetcher),
          (e: Error) => e instanceof ProviderTransientError,
          `statusCode ${codigo} precisa voltar para a fila, não desistir`);
      }
    });
  });

  await t.test("resposta sem statusCode é recusada em vez de passar por sucesso", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor({ "/autoupload/import": { corpo: { token: "x" } } });
      await assert.rejects(importarAnunciosOlx(cfgOlx, "t", [{}], fetcher),
        (e: Error) => e instanceof OrderError && /sem statusCode/.test(e.message));
    });
  });

  await t.test("corpo acima de 1 MB é recusado com o tamanho, antes de sair", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher, chamadas } = provedor(importacaoOk);
      const gigante = [{ Body: "x".repeat(1024 * 1024 + 10) }];
      await assert.rejects(importarAnunciosOlx(cfgOlx, "t", gigante, fetcher),
        (e: Error) => e instanceof OrderError && /KB/.test(e.message));
      // A mensagem do provedor não diz o tamanho, e sem o número ninguém sabe
      // quanto cortar -- por isso a recusa é nossa e não chega a sair.
      assert.equal(chamadas.length, 0);
    });
  });

  await t.test("a consulta da importação é POST com o token no caminho", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher, chamadas } = provedor({
        "/autoupload/import/imp-1": {
          corpo: {
            autoupload_status: "done",
            ads: [{ status: "accepted", operation: "insert", list_id: 987, url: "https://olx.com.br/a", message: [] }],
          },
        },
      });
      const consulta = await consultarImportacaoOlx(cfgOlx, "token-olx", "imp-1", fetcher);
      assert.equal(chamadas[0].metodo, "POST");
      assert.deepEqual(chamadas[0].corpo, { access_token: "token-olx" });
      assert.equal(consulta.geral, "done");
      assert.deepEqual(consulta.anuncios[0],
        { status: "accepted", listId: "987", url: "https://olx.com.br/a", mensagens: [] });
    });
  });
});

test("publicação completa na OLX", async (t) => {
  await t.test("aceito registra list_id e URL do anúncio publicado", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor({
        "/autoupload/import/imp-1": {
          corpo: {
            autoupload_status: "done",
            ads: [{ status: "accepted", list_id: 987, url: "https://olx.com.br/anuncio", message: [] }],
          },
        },
        "/autoupload/import": { corpo: { token: "imp-1", statusCode: 0 } },
      });
      const resultado = await publishOlxAd(cfgOlx, "token-olx", anuncio(), ANUNCIANTE, fetcher);
      // O identificador é o que NÓS mandamos: é por ele que a OLX casa a
      // próxima edição.
      assert.equal(resultado.externalListingId, "listing-1");
      assert.equal(resultado.price, "80.00");
      assert.equal(resultado.externalStatus, "accepted");
      assert.deepEqual(resultado.sentAttributes, {
        importacao: "imp-1", listId: "987", url: "https://olx.com.br/anuncio", mensagens: [],
      });
    });
  });

  await t.test("recusa vira falha com o motivo do provedor", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor({
        "/autoupload/import/imp-1": {
          corpo: {
            autoupload_status: "done",
            ads: [{ status: "refused", message: ["ERROR_IMAGE_TOO_SMALL", "REFUSED_SUSPECT_CATEGORY"] }],
          },
        },
        "/autoupload/import": { corpo: { token: "imp-1", statusCode: 0 } },
      });
      // Sem isto o anúncio ficaria marcado como publicado tendo sido rejeitado.
      await assert.rejects(publishOlxAd(cfgOlx, "token-olx", anuncio(), ANUNCIANTE, fetcher),
        (e: Error) => e instanceof OrderError && /ERROR_IMAGE_TOO_SMALL/.test(e.message));
    });
  });

  await t.test("fila ainda pendente é publicação, não falha", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor({
        "/autoupload/import/imp-1": {
          corpo: { autoupload_status: "pending", ads: [{ status: "queued", message: [] }] },
        },
        "/autoupload/import": { corpo: { token: "imp-1", statusCode: 0 } },
      });
      const resultado = await publishOlxAd(cfgOlx, "token-olx", anuncio(), ANUNCIANTE, fetcher);
      assert.equal(resultado.externalStatus, "queued");
    });
  });

  await t.test("falha na CONSULTA não derruba um anúncio que a OLX aceitou", async () => {
    await comAmbiente(ambiente, async () => {
      const { fetcher } = provedor({
        "/autoupload/import/imp-1": { status: 503, corpo: {} },
        "/autoupload/import": { corpo: { token: "imp-1", statusCode: 0 } },
      });
      const resultado = await publishOlxAd(cfgOlx, "token-olx", anuncio(), ANUNCIANTE, fetcher);
      assert.equal(resultado.externalStatus, "queued");
      // A importação fica registrada: é por ela que se descobre o destino depois.
      assert.deepEqual(resultado.sentAttributes,
        { importacao: "imp-1", listId: null, url: null, mensagens: [] });
    });
  });
});

test("a OLX não tem pedidos, e isso é dito com clareza", async (t) => {
  await t.test("a conciliação recusa nomeando a razão", async () => {
    await assert.rejects(
      // Banco nulo de propósito: a recusa da OLX não tem o que consultar, e
      // se algum dia ela passar a ir ao banco, este teste quebra.
      providerLister(semBanco)(conexao({ accessToken: "cifrado" }), new Date()),
      (e: Error) => e instanceof OrderError && /só de publicação/.test(e.message),
      "não é omissão: classificados não têm pedido para conciliar");
  });

  await t.test("o resolver de pedido recusa pelo mesmo motivo", async () => {
    const evento = {
      id: "evt-1", externalEventId: "x", externalOrderId: "1", payload: {},
      marketplaceId: "mkt-1", organizationId: "org-1",
      connection: conexao({ accessToken: "cifrado" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assert.rejects(providerResolver({} as any)(evento),
      (e: Error) => e instanceof OrderError && /só de publicação/.test(e.message));
  });
});
