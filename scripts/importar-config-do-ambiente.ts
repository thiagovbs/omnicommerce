/**
 * Leva para o banco a configuração de canal que mora em variável de ambiente.
 *
 * Roda no build (`build:vercel`), que é onde as variáveis da Vercel existem e
 * onde `prisma migrate deploy` já roda. Depois disto, quem lê configuração de
 * provedor lê do banco: o ambiente deixa de ser fonte e passa a ser só a
 * origem desta importação.
 *
 * Três propriedades, nesta ordem de importância:
 *
 * 1. **Não sobrescreve.** Chave que já existe no banco é preservada -- o que
 *    foi digitado na tela vale mais que o que sobrou no ambiente. Sem isso,
 *    cada deploy desfaria a edição de quem administra.
 * 2. **Idempotente.** Rodar de novo não muda nada e não falha.
 * 3. **Não derruba o build.** Variável ausente é canal sem aquela chave, que a
 *    tela já sabe mostrar como pendência. Falha de banco também não derruba:
 *    um deploy que não consegue importar é melhor que um deploy que não sai --
 *    e a tela segue dizendo o que falta.
 *
 * O valor NUNCA é impresso. O relatório diz a chave e o canal, nada mais.
 */

import { MarketplaceProvider, PrismaClient } from "@prisma/client";
import { camposDoProvedor } from "../lib/domain/marketplace-config";
import { encryptSecret } from "../lib/integrations/crypto";
import { hashDeBusca } from "../lib/services/marketplaces";

/// De qual variável de ambiente vem cada chave de cada provedor. É o mapa do
/// "antes" para o "depois", e existe só aqui: nenhum outro lugar do código
/// volta a ler estas variáveis.
const ORIGEM: Record<MarketplaceProvider, Record<string, string>> = {
  MERCADO_LIVRE: {
    appId: "MERCADO_LIVRE_APP_ID",
    appSecret: "MERCADO_LIVRE_APP_SECRET",
    webhookSecret: "MERCADO_LIVRE_WEBHOOK_SECRET",
    scope: "MERCADO_LIVRE_SCOPE",
    authUrl: "MERCADO_LIVRE_AUTH_URL",
    tokenUrl: "MERCADO_LIVRE_TOKEN_URL",
  },
  SHOPEE: {
    partnerId: "SHOPEE_PARTNER_ID",
    partnerKey: "SHOPEE_PARTNER_KEY",
    sandbox: "SHOPEE_SANDBOX",
    host: "SHOPEE_HOST",
    webhookSecret: "SHOPEE_WEBHOOK_SECRET",
    verifyPush: "SHOPEE_VERIFY_PUSH",
    defaultWeightKg: "SHOPEE_DEFAULT_WEIGHT_KG",
  },
  OLX: {
    clientId: "OLX_CLIENT_ID",
    clientSecret: "OLX_CLIENT_SECRET",
    apiUrl: "OLX_API_URL",
    authUrl: "OLX_AUTH_URL",
    tokenUrl: "OLX_TOKEN_URL",
    scope: "OLX_SCOPE",
    userInfoPath: "OLX_USER_INFO_PATH",
  },
  // Vazio de propósito: o canal do Facebook nasceu depois de a configuração
  // já morar no banco, e nunca teve variável de ambiente para trazer. A
  // entrada fica aqui para o mapa continuar cobrindo todos os provedores --
  // o dia em que faltar um, o compilador avisa.
  FACEBOOK: {},
  SEBO_ONLINE: {
    apiUrl: "SEBO_API_URL",
    webhookSecret: "SEBO_WEBHOOK_SECRET",
  },
};

export async function importarConfigDoAmbiente(db: PrismaClient) {
  const canais = await db.marketplace.findMany({
    where: { provider: { not: null } },
    select: {
      id: true, name: true, provider: true,
      organization: { select: { name: true } },
      settings: { select: { key: true } },
    },
  });

  const relatorio: string[] = [];
  let gravadas = 0;

  for (const canal of canais) {
    if (!canal.provider) continue;
    const origem = ORIGEM[canal.provider] ?? {};
    const jaTem = new Set(canal.settings.map((s) => s.key));
    const campos = new Map(camposDoProvedor(canal.provider).map((c) => [c.chave, c]));

    for (const [chave, variavel] of Object.entries(origem)) {
      if (jaTem.has(chave)) continue; // o banco manda
      const valor = (process.env[variavel] ?? "").trim();
      if (!valor) continue;
      const campo = campos.get(chave);
      if (!campo) continue; // chave que saiu do catálogo

      const segredo = campo.tipo === "segredo";
      await db.marketplaceSetting.create({ data: {
        marketplaceId: canal.id,
        key: chave,
        value: segredo ? encryptSecret(valor) : valor,
        secret: segredo,
        lookupHash: campo.buscavel ? hashDeBusca(valor) : null,
      } });
      gravadas += 1;
      relatorio.push(
        `  ${canal.organization.name} / ${canal.name}: ${chave} <- ${variavel}`);
    }
  }

  return { gravadas, canais: canais.length, relatorio };
}

export async function main() {
  const db = new PrismaClient();
  try {
    const { gravadas, canais, relatorio } = await importarConfigDoAmbiente(db);
    console.log(`[config] ${canais} canal(is) com provedor; ${gravadas} chave(s) importada(s) do ambiente.`);
    for (const linha of relatorio) console.log(linha);
    if (!gravadas) console.log("[config] Nada a importar: o banco já tem o que o ambiente oferecia.");
  } catch (error) {
    // Deploy não cai por causa disto: a tela de Marketplaces continua dizendo
    // o que falta, e a importação pode ser refeita.
    console.warn("[config] Importação não concluída:", error instanceof Error ? error.message : error);
  } finally {
    await db.$disconnect();
  }
}
