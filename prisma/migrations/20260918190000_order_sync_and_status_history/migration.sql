BEGIN;

CREATE TYPE "SaleSource" AS ENUM ('MANUAL', 'INTEGRATION');
CREATE TYPE "SaleStatusChangeSource" AS ENUM ('MANUAL', 'INTEGRATION', 'INITIALIZATION');

ALTER TABLE "Sale"
    ADD COLUMN "externalStatus" TEXT,
    ADD COLUMN "externalUpdatedAt" TIMESTAMP(3),
    ADD COLUMN "lastSyncedAt" TIMESTAMP(3),
    ADD COLUMN "source" "SaleSource" NOT NULL DEFAULT 'MANUAL',
    ADD COLUMN "statusVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "SaleItem"
    ADD COLUMN "externalItemId" TEXT,
    ADD COLUMN "externalVariationId" TEXT;

CREATE TABLE "SaleStatusHistory" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "fromStatus" "SaleStatus",
    "toStatus" "SaleStatus" NOT NULL,
    "source" "SaleStatusChangeSource" NOT NULL,
    "version" INTEGER NOT NULL,
    "externalEventId" TEXT,
    "externalStatus" TEXT,
    "occurredAt" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedById" TEXT,
    "reason" TEXT,
    CONSTRAINT "SaleStatusHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SaleStatusHistory_saleId_recordedAt_idx" ON "SaleStatusHistory"("saleId", "recordedAt");
CREATE INDEX "SaleStatusHistory_changedById_idx" ON "SaleStatusHistory"("changedById");
CREATE UNIQUE INDEX "SaleStatusHistory_saleId_version_key" ON "SaleStatusHistory"("saleId", "version");
CREATE UNIQUE INDEX "SaleStatusHistory_saleId_externalEventId_key" ON "SaleStatusHistory"("saleId", "externalEventId");
CREATE INDEX "Sale_organizationId_status_soldAt_idx" ON "Sale"("organizationId", "status", "soldAt");

ALTER TABLE "SaleStatusHistory" ADD CONSTRAINT "SaleStatusHistory_saleId_fkey"
    FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SaleStatusHistory" ADD CONSTRAINT "SaleStatusHistory_changedById_fkey"
    FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Snapshot only: updatedAt does not prove when the current status was reached.
-- Do not invent a previous status, a user, or a marketplace occurrence timestamp.
INSERT INTO "SaleStatusHistory" (
    "id", "saleId", "toStatus", "source", "version", "reason"
)
SELECT
    'initial-status:' || "id", "id", "status", 'INITIALIZATION', 0,
    'Estado existente no momento da migration; transicoes anteriores desconhecidas.'
FROM "Sale";

COMMIT;
