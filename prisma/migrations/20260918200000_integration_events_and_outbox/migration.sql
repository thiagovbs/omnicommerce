BEGIN;
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'INTEGRATION');
CREATE TYPE "IntegrationEventStatus" AS ENUM ('PENDING', 'PROCESSED', 'IGNORED', 'FAILED');
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

ALTER TABLE "AuditLog" ADD COLUMN "actorType" "AuditActorType" NOT NULL DEFAULT 'USER',
    ADD COLUMN "integrationEventId" TEXT,
    ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_userId_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "IntegrationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketplaceId" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "IntegrationEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3)
);
CREATE TABLE "OutboxMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "publishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "IntegrationEvent_marketplaceId_externalEventId_key" ON "IntegrationEvent"("marketplaceId", "externalEventId");
CREATE INDEX "IntegrationEvent_marketplaceId_externalOrderId_idx" ON "IntegrationEvent"("marketplaceId", "externalOrderId");
CREATE INDEX "IntegrationEvent_status_receivedAt_idx" ON "IntegrationEvent"("status", "receivedAt");
CREATE UNIQUE INDEX "OutboxMessage_eventId_key" ON "OutboxMessage"("eventId");
CREATE INDEX "OutboxMessage_status_availableAt_leaseUntil_idx" ON "OutboxMessage"("status", "availableAt", "leaseUntil");
CREATE INDEX "AuditLog_integrationEventId_idx" ON "AuditLog"("integrationEventId");
ALTER TABLE "IntegrationEvent" ADD CONSTRAINT "IntegrationEvent_marketplaceId_fkey" FOREIGN KEY ("marketplaceId") REFERENCES "Marketplace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "IntegrationEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_integrationEventId_fkey" FOREIGN KEY ("integrationEventId") REFERENCES "IntegrationEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
COMMIT;
