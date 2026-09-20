-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "connectionId" TEXT;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MarketplaceConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preenche a conta dos anúncios que já existem, mas só onde ela é inequívoca:
-- canal com exatamente uma conexão ativa. Canal com mais de uma é justamente o
-- caso que motivou a coluna -- adivinhar aqui repetiria o defeito que ela
-- corrige, e o anúncio fica sem conta até alguém escolher.
UPDATE "Listing" AS l
SET "connectionId" = unica."id"
FROM (
    SELECT "marketplaceId", MIN("id") AS "id"
    FROM "MarketplaceConnection"
    WHERE "status" = 'ACTIVE'
    GROUP BY "marketplaceId"
    HAVING COUNT(*) = 1
) AS unica
WHERE l."marketplaceId" = unica."marketplaceId"
  AND l."connectionId" IS NULL;
