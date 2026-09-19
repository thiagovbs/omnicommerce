-- Marca própria da conciliação, independente do avanço causado pelos avisos.
ALTER TABLE "MarketplaceConnection" ADD COLUMN "lastReconciledAt" TIMESTAMP(3);
