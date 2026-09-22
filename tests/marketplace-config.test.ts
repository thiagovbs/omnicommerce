import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { MarketplaceProvider, PrismaClient } from "@prisma/client";
import {
  camposDoProvedor, codigoDoProvedor, faltaParaConfigurar, parseMarketplaceSettings,
  PROVEDORES,
} from "../lib/domain/marketplace-config";
import { OrderError } from "../lib/domain/order-input";
import {
  canalPorSegredoDeWebhook, listMarketplaces, marketplaceSettings,
  saveMarketplaceSettings, upsertMarketplace,
} from "../lib/services/marketplaces";
import { importarConfigDoAmbiente } from "../scripts/importar-config-do-ambiente";

/**
 * Configuração de canal por organização.
 *
 * O que este arquivo protege, em ordem de importância:
 *
 * 1. **A credencial não volta em claro, e não vai para o log.** É o único
 *    defeito aqui que não tem correção depois: um segredo que apareceu num log
 *    ou numa tela precisa ser trocado no provedor.
 * 2. **Um canal por provedor por organização.** A conexão é única por
 *    (provedor, conta); com dois canais do mesmo provedor, autorizar a partir
 *    do segundo MOVE a conexão e os pedidos passam a entrar no canal errado,
 *    sem erro visível.
 * 3. **O segredo do webhook identifica o tenant.** O provedor chama a URL sem
 *    dizer de quem é o aviso; se a busca por ele falhar, nenhum pedido entra.
 * 4. **A importação do ambiente não sobrescreve o que foi digitado.** Sem
 *    isso, cada deploy desfaria a edição de quem administra.
 */

// Único por execução: o banco de teste é compartilhado entre as suítes, e a
// busca é POR VALOR -- um segredo repetido em outra suíte faria esta achar o
// canal dela (que é exatamente o defeito que a busca por hash evita em
// produção, onde dois canais não compartilham segredo).
const SEGREDO = `segredo-de-webhook-${randomBytes(12).toString("hex")}`;

test("catálogo de configuração, sem banco", async (t) => {
  await t.test("todo provedor da lista tem campos, e todo obrigatório é nomeado", () => {
    for (const { provider } of PROVEDORES) {
      const campos = camposDoProvedor(provider);
      assert.ok(campos.length > 0, `${provider} sem campos`);
      for (const campo of campos) {
        assert.ok(campo.rotulo.trim(), `${provider}.${campo.chave} sem rótulo`);
        // A ajuda é o que a tela mostra; sem ela, "App Secret" não diz nada a
        // quem nunca abriu o painel do provedor.
        assert.ok(campo.ajuda.trim(), `${provider}.${campo.chave} sem ajuda`);
      }
    }
  });

  await t.test("o código do canal deriva do provedor e não muda", () => {
    // Estes valores estão gravados em canais que já existem, e a árvore de
    // categorias e os logs os referenciam: mudá-los é migração, não renomeação.
    assert.equal(codigoDoProvedor("MERCADO_LIVRE"), "mercado_livre");
    assert.equal(codigoDoProvedor("SHOPEE"), "shopee");
    assert.equal(codigoDoProvedor("OLX"), "olx");
    assert.equal(codigoDoProvedor("SEBO_ONLINE"), "sebo");
    assert.equal(codigoDoProvedor("FACEBOOK"), "facebook");
  });

  await t.test("o provedor aceito no cadastro é o que a tela oferece", () => {
    // A lista de provedores válidos já foi escrita à mão no serviço, e o
    // sintoma de ela ficar para trás é a tela oferecer um canal que o servidor
    // recusa. Aqui as duas pontas são conferidas contra o enum do banco.
    const doEnum = Object.values(MarketplaceProvider).sort();
    assert.deepEqual(PROVEDORES.map((p) => p.provider).sort(), doEnum);
  });

  await t.test("normaliza URL e recusa o que não serve", () => {
    const valores = parseMarketplaceSettings("SEBO_ONLINE", {
      apiUrl: "https://api-assets.sensedia.com/sebo/api/",
    });
    assert.equal(valores.apiUrl.valor, "https://api-assets.sensedia.com/sebo/api",
      "barra no fim vira duas ao montar o caminho");
    assert.equal(valores.apiUrl.segredo, false);

    for (const ruim of ["http://api.exemplo.com", "https://u:p@api.exemplo.com",
      "https://api.exemplo.com?x=1", "nao-e-url"]) {
      assert.throws(() => parseMarketplaceSettings("SEBO_ONLINE", { apiUrl: ruim }),
        /URL da API do Sebo/);
    }
  });

  await t.test("campo obrigatório em branco é erro; opcional em branco é remoção", () => {
    assert.throws(() => parseMarketplaceSettings("MERCADO_LIVRE", { appId: "  " }),
      /App ID é obrigatório/);
    const valores = parseMarketplaceSettings("MERCADO_LIVRE", { appId: "1", appSecret: "s", scope: "" });
    assert.equal("scope" in valores, false, "vazio não vira string vazia gravada");
  });

  await t.test("campo fora do catálogo é recusado, não ignorado", () => {
    // Ignorar em silêncio gravaria lixo que ninguém lê -- e esconderia erro de
    // digitação na chave, que é o caso comum.
    assert.throws(() => parseMarketplaceSettings("MERCADO_LIVRE", { appIdd: "1" }),
      /Campo desconhecido/);
  });

  await t.test("tipo é conferido: número, booleano e o mínimo do segredo", () => {
    assert.throws(() => parseMarketplaceSettings("SHOPEE",
      { partnerId: "abc", partnerKey: "k" }), /apenas números/);
    assert.throws(() => parseMarketplaceSettings("SHOPEE",
      { partnerId: "1", partnerKey: "k", sandbox: "talvez" }), /valor inválido/);
    // Segredo de webhook curto é adivinhável, e o endpoint responde 404 a quem
    // erra -- o sintoma seria "nenhum pedido chegou".
    assert.throws(() => parseMarketplaceSettings("MERCADO_LIVRE",
      { appId: "1", appSecret: "s", webhookSecret: "curto" }), /32 caracteres/);
  });

  await t.test("o que falta é dito em rótulo de tela", () => {
    assert.deepEqual(faltaParaConfigurar("MERCADO_LIVRE", []), ["App ID", "App Secret"]);
    assert.deepEqual(faltaParaConfigurar("MERCADO_LIVRE", ["appId", "appSecret"]), []);
    // Opcional em branco não é pendência: o boleto do canal funciona sem ele.
    assert.deepEqual(faltaParaConfigurar("SEBO_ONLINE", ["apiUrl"]), []);
  });
});

test("configuração de canal em PostgreSQL", async (t) => {
  const db = new PrismaClient();
  const chaveAnterior = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  try {
    const org = await db.organization.create({ data: { name: "Config A" } });
    const admin = await db.user.create({ data: {
      organizationId: org.id, email: `cfg-a-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const ator = { userId: admin.id, organizationId: org.id };

    const outraOrg = await db.organization.create({ data: { name: "Config B" } });
    const outroAdmin = await db.user.create({ data: {
      organizationId: outraOrg.id, email: `cfg-b-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const outroAtor = { userId: outroAdmin.id, organizationId: outraOrg.id };

    const { id: canalId } = await upsertMarketplace(db, ator, {
      name: "Mercado Livre", provider: "MERCADO_LIVRE", active: true,
    });

    await t.test("o código é derivado do provedor, não digitado", async () => {
      const canal = await db.marketplace.findUniqueOrThrow({ where: { id: canalId } });
      assert.equal(canal.code, "mercado_livre");
      assert.equal(canal.provider, "MERCADO_LIVRE");
    });

    await t.test("segundo canal do mesmo provedor é recusado nomeando o primeiro", async () => {
      await assert.rejects(
        upsertMarketplace(db, ator, {
          name: "ML Outlet", provider: "MERCADO_LIVRE", active: true,
        }),
        (e: Error) => e instanceof OrderError && /Mercado Livre já está cadastrado/.test(e.message),
        "autorizar do canal errado moveria a conexão, e os pedidos entrariam no lugar errado");
      // Outra organização pode ter o dela: a unicidade é por organização.
      await upsertMarketplace(db, outroAtor, {
        name: "Mercado Livre", provider: "MERCADO_LIVRE", active: true,
      });
    });

    await t.test("grava a configuração e cifra o que é segredo", async () => {
      const resultado = await saveMarketplaceSettings(db, ator, canalId, {
        appId: "123456", appSecret: "segredo-da-aplicacao", webhookSecret: SEGREDO,
      });
      assert.equal(resultado.alteradas, 3);
      assert.deepEqual(resultado.falta, []);

      const linhas = await db.marketplaceSetting.findMany({ where: { marketplaceId: canalId } });
      const porChave = new Map(linhas.map((l) => [l.key, l]));
      assert.equal(porChave.get("appId")!.value, "123456", "não-segredo fica legível");
      // O segredo não pode estar em claro no banco: é o que sobra depois de um
      // dump, e trocá-lo exige mexer no provedor.
      assert.equal(porChave.get("appSecret")!.value.includes("segredo-da-aplicacao"), false);
      assert.equal(porChave.get("appSecret")!.secret, true);
      assert.equal(porChave.get("webhookSecret")!.lookupHash !== null, true,
        "o segredo do webhook precisa ser encontrável por valor");

      // E quem vai chamar o provedor recebe em claro.
      const cfg = await marketplaceSettings(db, canalId);
      assert.equal(cfg.appSecret, "segredo-da-aplicacao");
    });

    await t.test("a auditoria registra o NOME do campo, nunca o valor", async () => {
      const log = await db.auditLog.findFirstOrThrow({
        where: { entity: "MARKETPLACE", entityId: canalId },
        orderBy: { createdAt: "desc" },
      });
      assert.match(log.details ?? "", /appSecret/);
      // O log é lido por mais gente que o cofre.
      assert.equal(JSON.stringify(log.newData).includes("segredo-da-aplicacao"), false);
      assert.equal((log.details ?? "").includes("segredo-da-aplicacao"), false);
    });

    await t.test("gravar o mesmo valor de novo não conta como alteração", async () => {
      const resultado = await saveMarketplaceSettings(db, ator, canalId, {
        appId: "123456", appSecret: "segredo-da-aplicacao",
      });
      assert.equal(resultado.alteradas, 0, "inclusive o segredo, comparado após decifrar");
    });

    await t.test("campo em branco apaga; chave ausente não mexe em nada", async () => {
      await saveMarketplaceSettings(db, ator, canalId, { scope: "offline_access read" });
      assert.equal((await marketplaceSettings(db, canalId)).scope, "offline_access read");

      const resultado = await saveMarketplaceSettings(db, ator, canalId, { scope: "" });
      assert.equal(resultado.apagadas, 1);
      assert.equal("scope" in (await marketplaceSettings(db, canalId)), false);

      // O appId não foi enviado: continua lá. Vazio e ausente são coisas
      // diferentes, senão salvar uma aba do formulário apagaria a outra.
      assert.equal((await marketplaceSettings(db, canalId)).appId, "123456");
    });

    await t.test("o administrador de uma organização não configura o canal da outra", async () => {
      await assert.rejects(
        saveMarketplaceSettings(db, outroAtor, canalId, { appId: "999" }),
        (e: Error) => e instanceof OrderError && /não encontrado/.test(e.message));
      assert.equal((await marketplaceSettings(db, canalId)).appId, "123456");
    });

    await t.test("o segredo do webhook diz de qual canal é o aviso", async () => {
      const achado = await canalPorSegredoDeWebhook(db, "MERCADO_LIVRE", SEGREDO);
      assert.equal(achado?.marketplaceId, canalId);

      // Segredo errado não acha nada -- e é assim que o endpoint responde 404.
      assert.equal(await canalPorSegredoDeWebhook(db, "MERCADO_LIVRE", SEGREDO + "x"), null);
      assert.equal(await canalPorSegredoDeWebhook(db, "MERCADO_LIVRE", ""), null);
      // O mesmo segredo em provedor diferente não serve: a URL é por provedor.
      assert.equal(await canalPorSegredoDeWebhook(db, "SHOPEE", SEGREDO), null);
    });

    await t.test("a lista da tela mostra pendência e nunca o valor do segredo", async () => {
      const linhas = await listMarketplaces(db, ator);
      const canal = linhas.find((c) => c.id === canalId)!;
      assert.equal(canal.provider, "MERCADO_LIVRE");
      assert.deepEqual(canal.falta, [], "os obrigatórios estão preenchidos");
      assert.equal(canal.preenchidas.includes("appSecret"), true);
      // O que atravessa para o cliente é o nome da chave, não o conteúdo.
      assert.equal(JSON.stringify(canal).includes("segredo-da-aplicacao"), false);

      const semConfig = await upsertMarketplace(db, ator, {
        name: "Shopee", provider: "SHOPEE", active: true,
      });
      const shopee = (await listMarketplaces(db, ator)).find((c) => c.id === semConfig.id)!;
      assert.deepEqual(shopee.falta, ["Partner ID", "Partner Key"]);
    });

    await t.test("trocar o provedor de um canal com histórico é recusado", async () => {
      // INACTIVE de propósito: ela existe só para provar que há histórico. Ativa,
      // entraria na rodada de conciliação das outras suítes, que compartilham
      // este banco.
      await db.marketplaceConnection.create({ data: {
        marketplaceId: canalId, provider: "MERCADO_LIVRE", status: "INACTIVE",
        externalAccountId: `conta-${Date.now()}`, accessToken: "cifrado",
      } });
      await assert.rejects(
        upsertMarketplace(db, ator, {
          id: canalId, name: "Mercado Livre", provider: "OLX", active: true,
        }),
        (e: Error) => e instanceof OrderError && /histórico/.test(e.message),
        "levaria conexão, anúncio e venda para outro provedor");
    });

    await t.test("importação do ambiente: preenche o que falta e respeita o que existe", async () => {
      const canalSebo = await upsertMarketplace(db, ator, {
        name: "Sebo Online", provider: "SEBO_ONLINE", active: true,
      });
      const anteriores = {
        SEBO_API_URL: process.env.SEBO_API_URL,
        SEBO_WEBHOOK_SECRET: process.env.SEBO_WEBHOOK_SECRET,
        MERCADO_LIVRE_APP_ID: process.env.MERCADO_LIVRE_APP_ID,
      };
      process.env.SEBO_API_URL = "https://sebo.exemplo.com/api";
      process.env.SEBO_WEBHOOK_SECRET = SEGREDO;
      // O canal do ML já tem appId gravado pela tela: o ambiente NÃO manda.
      process.env.MERCADO_LIVRE_APP_ID = "do-ambiente";
      try {
        const primeira = await importarConfigDoAmbiente(db);
        assert.ok(primeira.gravadas >= 2);

        const cfgSebo = await marketplaceSettings(db, canalSebo.id);
        assert.equal(cfgSebo.apiUrl, "https://sebo.exemplo.com/api");
        assert.equal(cfgSebo.webhookSecret, SEGREDO, "segredo entra cifrado e volta em claro");
        const linhaSegredo = await db.marketplaceSetting.findUniqueOrThrow({
          where: { marketplaceId_key: { marketplaceId: canalSebo.id, key: "webhookSecret" } },
        });
        assert.equal(linhaSegredo.secret, true);
        assert.equal(linhaSegredo.value.includes(SEGREDO), false);

        // O que a tela gravou continua valendo.
        assert.equal((await marketplaceSettings(db, canalId)).appId, "123456");

        // E rodar de novo não muda nada: o build roda isto a cada deploy.
        const segunda = await importarConfigDoAmbiente(db);
        assert.equal(segunda.gravadas, 0);
      } finally {
        for (const [k, v] of Object.entries(anteriores)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  } finally {
    if (chaveAnterior === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
    else process.env.INTEGRATION_ENCRYPTION_KEY = chaveAnterior;
    await db.$disconnect();
  }
});
