-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "categoryExternalId" TEXT,
ADD COLUMN     "publishedCategoryId" TEXT;

-- CreateTable
CREATE TABLE "MarketplaceCategory" (
    "id" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentExternalId" TEXT,
    "leaf" BOOLEAN NOT NULL,
    "path" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "listingAllowed" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketplaceCategory_marketplaceId_parentExternalId_idx" ON "MarketplaceCategory"("marketplaceId", "parentExternalId");

-- CreateIndex
CREATE INDEX "MarketplaceCategory_marketplaceId_leaf_idx" ON "MarketplaceCategory"("marketplaceId", "leaf");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceCategory_marketplaceId_externalId_key" ON "MarketplaceCategory"("marketplaceId", "externalId");

-- AddForeignKey
ALTER TABLE "MarketplaceCategory" ADD CONSTRAINT "MarketplaceCategory_marketplaceId_fkey" FOREIGN KEY ("marketplaceId") REFERENCES "Marketplace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

