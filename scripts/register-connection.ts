import { MarketplaceProvider, PrismaClient } from "@prisma/client";
import { encryptSecret } from "../lib/integrations/crypto";

/**
 * Cadastra ou atualiza uma conexão autorizada enquanto o fluxo OAuth não existe.
 *
 * Os valores vêm de variáveis de ambiente, não de argumentos, para o token não
 * ficar no histórico do shell. Requer INTEGRATION_ENCRYPTION_KEY definido.
 *
 *   CONNECTION_ORG_NAME="Org Demo" CONNECTION_MARKETPLACE_CODE="mercado_livre" \
 *   CONNECTION_PROVIDER="MERCADO_LIVRE" CONNECTION_ACCOUNT_ID="123456789" \
 *   CONNECTION_ACCESS_TOKEN="APP_USR-..." CONNECTION_EXPIRES_IN="21600" \
 *   npm run connection:register
 */
const prisma = new PrismaClient();

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável ${name} é obrigatória.`);
  return value;
}

async function main() {
  const orgName = required("CONNECTION_ORG_NAME");
  const code = required("CONNECTION_MARKETPLACE_CODE");
  const provider = required("CONNECTION_PROVIDER");
  const externalAccountId = required("CONNECTION_ACCOUNT_ID");
  const accessToken = required("CONNECTION_ACCESS_TOKEN");
  const refreshToken = process.env.CONNECTION_REFRESH_TOKEN?.trim() || null;
  const expiresIn = process.env.CONNECTION_EXPIRES_IN?.trim();

  if (!Object.values(MarketplaceProvider).includes(provider as MarketplaceProvider)) {
    throw new Error(`CONNECTION_PROVIDER deve ser um de: ${Object.values(MarketplaceProvider).join(", ")}.`);
  }
  if (expiresIn && !/^\d{1,8}$/.test(expiresIn)) throw new Error("CONNECTION_EXPIRES_IN deve ser em segundos.");

  const organization = await prisma.organization.findFirst({ where: { name: orgName }, select: { id: true } });
  if (!organization) throw new Error(`Organização "${orgName}" não encontrada.`);
  const marketplace = await prisma.marketplace.findUnique({
    where: { organizationId_code: { organizationId: organization.id, code } },
    select: { id: true, active: true },
  });
  if (!marketplace) throw new Error(`Marketplace "${code}" não encontrado nessa organização.`);
  if (!marketplace.active) throw new Error(`Marketplace "${code}" está inativo.`);

  const credentials = {
    status: "ACTIVE" as const,
    accessToken: encryptSecret(accessToken),
    refreshToken: refreshToken ? encryptSecret(refreshToken) : null,
    expiresAt: expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000) : null,
  };

  const connection = await prisma.marketplaceConnection.upsert({
    where: { provider_externalAccountId: { provider: provider as MarketplaceProvider, externalAccountId } },
    update: { marketplaceId: marketplace.id, ...credentials },
    create: { marketplaceId: marketplace.id, provider: provider as MarketplaceProvider, externalAccountId, ...credentials },
    select: { id: true, expiresAt: true },
  });

  // Nenhum token é impresso.
  console.log(`Conexão ${connection.id} pronta para ${provider}/${externalAccountId} em ${orgName}/${code}.`);
  console.log(connection.expiresAt
    ? `Credencial expira em ${connection.expiresAt.toISOString()}.`
    : "Sem validade informada: a credencial não será tratada como expirada.");
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (error: Error) => {
    console.error(`Falha ao cadastrar conexão: ${error.message}`);
    await prisma.$disconnect();
    process.exit(1);
  });
