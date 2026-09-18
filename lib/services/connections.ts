import "server-only";
import { MarketplaceProvider, PrismaClient } from "@prisma/client";
import { OrderError, textInput } from "../domain/order-input";
import { encryptSecret } from "../integrations/crypto";
import { assertOrgAdmin } from "./access";
import { UserActor } from "./sales";
import { serializable } from "./transactions";

export interface ProviderTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

// Grava a loja autorizada. A organização vem da sessão e o marketplace é
// conferido dentro dela: nem provedor nem formulário escolhem o tenant.
export async function saveProviderConnection(db: PrismaClient, actor: UserActor, input: {
  provider: MarketplaceProvider;
  marketplaceId: string;
  externalAccountId: string;
  tokens: ProviderTokens;
}) {
  const marketplaceId = textInput(input.marketplaceId, "Marketplace");
  const externalAccountId = textInput(input.externalAccountId, "Conta do provedor", 100);
  if (!input.tokens.accessToken) throw new OrderError("Credencial ausente.");
  // Cifra fora da transação: é trabalho de CPU, não de banco.
  const credenciais = {
    status: "ACTIVE" as const,
    accessToken: encryptSecret(input.tokens.accessToken),
    refreshToken: input.tokens.refreshToken ? encryptSecret(input.tokens.refreshToken) : null,
    expiresAt: input.tokens.expiresAt,
  };

  return serializable(db, async (tx) => {
    await assertOrgAdmin(tx, actor);
    const marketplace = await tx.marketplace.findFirst({
      where: { id: marketplaceId, organizationId: actor.organizationId, active: true },
      select: { id: true, name: true },
    });
    if (!marketplace) throw new OrderError("Marketplace não encontrado ou inativo.");

    // A conta do provedor pertence a uma conexão só, e ela pode já estar noutro
    // tenant: recusar é melhor que roubar a conta silenciosamente.
    const existente = await tx.marketplaceConnection.findUnique({
      where: { provider_externalAccountId: { provider: input.provider, externalAccountId } },
      select: { id: true, marketplace: { select: { organizationId: true } } },
    });
    if (existente && existente.marketplace.organizationId !== actor.organizationId) {
      throw new OrderError("Essa conta já está conectada em outra organização.");
    }

    const connection = await tx.marketplaceConnection.upsert({
      where: { provider_externalAccountId: { provider: input.provider, externalAccountId } },
      update: { marketplaceId, ...credenciais },
      create: { marketplaceId, provider: input.provider, externalAccountId, ...credenciais },
      select: { id: true },
    });
    await tx.auditLog.create({ data: {
      action: existente ? "UPDATE" : "CREATE", entity: "MARKETPLACE_CONNECTION", entityId: connection.id,
      organizationId: actor.organizationId, userId: actor.userId,
      details: `Conexão ${input.provider}/${externalAccountId} autorizada em ${marketplace.name}.`,
      // Nunca o token: só o que identifica a conexão.
      newData: { provider: input.provider, externalAccountId, marketplaceId, expiresAt: credenciais.expiresAt },
    } });
    return { id: connection.id, marketplace: marketplace.name };
  });
}
