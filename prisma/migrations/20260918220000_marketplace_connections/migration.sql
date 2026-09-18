BEGIN;
CREATE TYPE "MarketplaceProvider" AS ENUM ('MERCADO_LIVRE', 'SHOPEE');
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'EXPIRED');

CREATE TABLE "MarketplaceConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketplaceId" TEXT NOT NULL,
    "provider" "MarketplaceProvider" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- A provider account maps to exactly one connection, so a notification resolves to one tenant.
CREATE UNIQUE INDEX "MarketplaceConnection_provider_externalAccountId_key"
    ON "MarketplaceConnection"("provider", "externalAccountId");
CREATE INDEX "MarketplaceConnection_marketplaceId_idx" ON "MarketplaceConnection"("marketplaceId");
ALTER TABLE "MarketplaceConnection" ADD CONSTRAINT "MarketplaceConnection_marketplaceId_fkey"
    FOREIGN KEY ("marketplaceId") REFERENCES "Marketplace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- IntegrationEvent.payload agora guarda a notificação crua; a conexão diz com quais
-- credenciais o pedido deve ser consultado.
ALTER TABLE "IntegrationEvent" ADD COLUMN "connectionId" TEXT;
CREATE INDEX "IntegrationEvent_connectionId_idx" ON "IntegrationEvent"("connectionId");
ALTER TABLE "IntegrationEvent" ADD CONSTRAINT "IntegrationEvent_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "MarketplaceConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
COMMIT;
