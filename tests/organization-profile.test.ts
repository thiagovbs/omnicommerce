import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { OrderError } from "../lib/domain/order-input";
import { cnpjValido, parseOrganizationProfile } from "../lib/domain/organization-input";
import { encryptSecret } from "../lib/integrations/crypto";
import { providerPublisher } from "../lib/integrations/publish";
import { organizationProfile, upsertOrganization } from "../lib/services/organizations";
import { createProduct } from "../lib/services/products";
import { requestPublication } from "../lib/services/listings";

/**
 * Cadastro da organização: o dado que era do ambiente e passou a ser do tenant.
 *
 * O que este arquivo protege, em ordem de importância:
 *
 * 1. O anúncio da OLX sai com o telefone e o CEP DA ORGANIZAÇÃO do produto. Era
 *    o defeito de desenho: num deploy que atende várias empresas, uma variável
 *    de ambiente serve a todas ao mesmo tempo, e o anúncio de uma sairia com o
 *    telefone da outra.
 * 2. CNPJ errado não entra. Ele só apareceria na nota ou no boleto do cliente.
 * 3. O administrador de uma organização não edita o cadastro da outra.
 */

const CNPJ_A = "11222333000181";
const CNPJ_B = "12345678000195";

test("cadastro da organização sem banco", async (t) => {
  await t.test("dígitos verificadores do CNPJ", () => {
    assert.equal(cnpjValido(CNPJ_A), true);
    assert.equal(cnpjValido("11.222.333/0001-81"), true, "máscara não muda o número");
    // Um dígito trocado no fim é o erro de digitação mais comum.
    assert.equal(cnpjValido("11222333000182"), false);
    assert.equal(cnpjValido("11222333000191"), false);
    // Sequência de um algarismo fecha a conta e não existe na vida real.
    assert.equal(cnpjValido("11111111111111"), false);
    assert.equal(cnpjValido("112223330001"), false, "curto demais");
  });

  await t.test("normaliza para dígitos e recusa o que está errado", () => {
    const perfil = parseOrganizationProfile({
      legalName: "  Empresa LTDA ", taxId: "11.222.333/0001-81",
      email: "Contato@Empresa.com.BR", phone: "(11) 98888-7777", zipCode: "01001-000",
      street: "Rua das Flores", number: "100", district: "Centro",
      city: "São Paulo", state: "sp",
    });
    // Guardado como a OLX, o boleto e a nota querem: só dígitos.
    assert.equal(perfil.taxId, "11222333000181");
    assert.equal(perfil.phone, "11988887777");
    assert.equal(perfil.zipCode, "01001000");
    assert.equal(perfil.email, "contato@empresa.com.br");
    assert.equal(perfil.state, "SP");
    assert.equal(perfil.legalName, "Empresa LTDA");

    assert.throws(() => parseOrganizationProfile({ taxId: "11222333000182" }), /CNPJ inválido/);
    assert.throws(() => parseOrganizationProfile({ zipCode: "123" }), /8 dígitos/);
    assert.throws(() => parseOrganizationProfile({ phone: "119" }), /DDD/);
    assert.throws(() => parseOrganizationProfile({ email: "sem-arroba" }), /E-mail inválido/);
    assert.throws(() => parseOrganizationProfile({ state: "XX" }), /UF inválida/);
  });

  await t.test("cadastro vazio é válido: a organização nasce só com o nome", () => {
    const perfil = parseOrganizationProfile({});
    assert.equal(perfil.taxId, "");
    assert.equal(perfil.state, "");
  });
});

test("cadastro da organização em PostgreSQL", async (t) => {
  const db = new PrismaClient();
  const anterior = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  try {
    const plataforma = await db.organization.create({ data: { name: "Plataforma" } });
    const operador = await db.user.create({ data: {
      organizationId: plataforma.id, email: `plat-${Date.now()}@local.test`,
      name: "Operador", passwordHash: "x", role: "PLATFORM_ADMIN",
    } });
    const atorPlataforma = { userId: operador.id, organizationId: plataforma.id };

    const criada = await upsertOrganization(db, atorPlataforma, {
      name: "Loja do Cadastro", legalName: "Loja do Cadastro LTDA", taxId: CNPJ_A,
      phone: "(11) 98888-7777", zipCode: "01001-000", street: "Rua das Flores",
      number: "100", district: "Centro", city: "São Paulo", state: "SP",
    });
    const admin = await db.user.create({ data: {
      organizationId: criada.id, email: `admin-cad-${Date.now()}@local.test`,
      name: "Admin", passwordHash: "x", role: "ADMIN",
    } });
    const ator = { userId: admin.id, organizationId: criada.id };

    await t.test("a criação já grava o cadastro inteiro", async () => {
      const perfil = await organizationProfile(db, criada.id);
      assert.equal(perfil.legalName, "Loja do Cadastro LTDA");
      assert.equal(perfil.taxId, CNPJ_A);
      assert.equal(perfil.phone, "11988887777");
      assert.equal(perfil.zipCode, "01001000");
      assert.equal(perfil.city, "São Paulo");
    });

    await t.test("o administrador edita o cadastro da própria organização", async () => {
      const resultado = await upsertOrganization(db, ator, {
        id: criada.id, name: "Loja do Cadastro", legalName: "Loja do Cadastro LTDA",
        taxId: CNPJ_A, phone: "(11) 97777-6666", zipCode: "04567-000",
        street: "Avenida Nova", number: "200", district: "Centro",
        city: "São Paulo", state: "SP",
      });
      assert.equal(resultado.mudancas, 4, "telefone, CEP, logradouro e número");
      const perfil = await organizationProfile(db, criada.id);
      assert.equal(perfil.phone, "11977776666");
      assert.equal(perfil.street, "Avenida Nova");
    });

    await t.test("a auditoria registra só o que mudou", async () => {
      await upsertOrganization(db, ator, {
        id: criada.id, name: "Loja do Cadastro", legalName: "Loja do Cadastro LTDA",
        taxId: CNPJ_A, phone: "(11) 97777-6666", zipCode: "04567-000",
        street: "Avenida Nova", number: "200", district: "Centro",
        city: "Campinas", state: "SP",
      });
      const log = await db.auditLog.findFirstOrThrow({
        where: { entity: "ORGANIZATION", entityId: criada.id },
        orderBy: { createdAt: "desc" },
      });
      // Repetir o cadastro inteiro a cada salvamento esconderia a alteração em
      // vez de mostrá-la.
      assert.match(log.details ?? "", /city/);
      assert.equal((log.newData as Record<string, unknown>).city, "Campinas");
      assert.equal((log.oldData as Record<string, unknown>).city, "São Paulo");
      assert.equal("district" in (log.newData as object), false);
    });

    await t.test("CNPJ de outra organização é recusado nomeando ela", async () => {
      const outra = await upsertOrganization(db, atorPlataforma, {
        name: "Outra Loja", taxId: CNPJ_B,
      });
      await assert.rejects(
        upsertOrganization(db, atorPlataforma, {
          id: outra.id, name: "Outra Loja", taxId: CNPJ_A,
        }),
        (e: Error) => e instanceof OrderError && /Loja do Cadastro/.test(e.message),
        "CNPJ repetido é quase sempre cadastro duplicado da mesma empresa");
      // E o próprio CNPJ continua podendo ser salvo de novo.
      await upsertOrganization(db, atorPlataforma, {
        id: outra.id, name: "Outra Loja", taxId: CNPJ_B, city: "Santos", state: "SP",
      });
    });

    await t.test("o administrador não edita o cadastro de outra organização", async () => {
      await assert.rejects(
        upsertOrganization(db, ator, {
          id: plataforma.id, name: "Plataforma", taxId: CNPJ_B,
        }),
        (e: Error) => e instanceof OrderError);
      assert.equal((await organizationProfile(db, plataforma.id)).taxId, "");
    });

    await t.test("o anúncio da OLX sai com o telefone e o CEP da organização dele", async () => {
      const canal = await db.marketplace.create({
        data: { organizationId: criada.id, code: "olx", name: "OLX da loja" },
      });
      await db.marketplaceConnection.create({ data: {
        marketplaceId: canal.id, provider: "OLX",
        externalAccountId: `conta-olx-${Date.now()}`, accessToken: encryptSecret("token-olx"),
      } });
      const produto = await createProduct(db, ator, {
        sku: "OLX-CAD-1", title: "Produto para classificado",
        description: "Descrição do anúncio.", price: "150.00", stock: 2,
        category: "1020", images: ["https://exemplo.invalid/a.png"],
      });
      const anuncio = await db.listing.upsert({
        where: { productId_marketplaceId: { productId: produto.id, marketplaceId: canal.id } },
        update: { categoryExternalId: "1020" },
        create: {
          productId: produto.id, marketplaceId: canal.id, categoryExternalId: "1020",
          status: "DRAFT", needsSync: false,
        },
        select: { id: true },
      });
      await requestPublication(db, ator, produto.id, [canal.id]);

      const enviados: Record<string, unknown>[] = [];
      const fetcher = (async (url: string, init: RequestInit = {}) => {
        const corpo = JSON.parse(String(init.body));
        enviados.push(corpo);
        if (String(url).includes("/autoupload/import/")) {
          return Response.json({ autoupload_status: "done", ads: [{ status: "queued", message: [] }] });
        }
        return Response.json({ token: "imp-1", statusCode: 0 });
      }) as unknown as typeof fetch;

      const listing = await db.listing.findUniqueOrThrow({
        where: { id: anuncio.id },
        include: { product: { include: { images: { orderBy: { position: "asc" } } } } },
      });
      const resultado = await providerPublisher(db, fetcher)(listing);
      assert.equal(resultado.externalListingId, listing.id);

      const importacao = enviados[0] as { ad_list: Record<string, unknown>[] };
      // Vem do cadastro da organização, não do ambiente -- que é o ponto.
      assert.equal(importacao.ad_list[0].Phone, 11977776666);
      assert.equal(importacao.ad_list[0].zipcode, "04567000");
    });

    await t.test("cadastro incompleto manda completar a organização", async () => {
      const semContato = await upsertOrganization(db, atorPlataforma, { name: "Sem Contato" });
      const adminSem = await db.user.create({ data: {
        organizationId: semContato.id, email: `admin-sem-${Date.now()}@local.test`,
        name: "Admin", passwordHash: "x", role: "ADMIN",
      } });
      const atorSem = { userId: adminSem.id, organizationId: semContato.id };
      const canal = await db.marketplace.create({
        data: { organizationId: semContato.id, code: "olx", name: "OLX sem cadastro" },
      });
      await db.marketplaceConnection.create({ data: {
        marketplaceId: canal.id, provider: "OLX",
        externalAccountId: `conta-olx2-${Date.now()}`, accessToken: encryptSecret("token-olx"),
      } });
      const produto = await createProduct(db, atorSem, {
        sku: "OLX-SEM-1", title: "Produto sem cadastro", description: "Descrição.",
        price: "80.00", stock: 1, images: ["https://exemplo.invalid/b.png"],
      });
      await db.listing.create({ data: {
        productId: produto.id, marketplaceId: canal.id, categoryExternalId: "1020",
        status: "PUBLISHING", needsSync: true,
      } });
      const listing = await db.listing.findFirstOrThrow({
        where: { productId: produto.id },
        include: { product: { include: { images: true } } },
      });

      // A recusa do provedor falaria de campo inválido, sem dizer que o dado
      // que falta é o da empresa, noutra tela.
      await assert.rejects(
        providerPublisher(db, (async () => Response.json({})) as unknown as typeof fetch)(listing),
        (e: Error) => e instanceof OrderError && /Organizações/.test(e.message));
    });
  } finally {
    if (anterior === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
    else process.env.INTEGRATION_ENCRYPTION_KEY = anterior;
    await db.$disconnect();
  }
});
