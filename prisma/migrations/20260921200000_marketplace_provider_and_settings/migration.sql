-- Provedor do canal e configuração de integração por organização.
--
-- Duas mudanças, pelo mesmo motivo: o canal dizia qual provedor era através de
-- um código DIGITADO, e as credenciais do provedor moravam no ambiente. As
-- duas coisas impedem uma segunda organização de usar a plataforma sozinha.
--
-- 1. `Marketplace.provider` passa a ser o campo de verdade, preenchido pela
--    lista suspensa da tela. O preenchimento inicial vem do próprio código,
--    com o mesmo mapa que o código já usava em lib/domain/marketplace-provider.ts
--    -- então nenhum canal existente muda de comportamento.
-- 2. `MarketplaceSetting` guarda a configuração de cada canal. Segredo vai
--    cifrado; `lookupHash` existe só para o segredo da URL de webhook, que
--    precisa ser encontrado por valor (o ciphertext tem IV aleatório).
--
-- A coluna fica anulável de propósito: canal antigo com código livre que não
-- casa com provedor nenhum continua válido como canal sem integração, que é o
-- que ele sempre foi. Em Postgres, índice único ignora nulos, então vários
-- canais sem provedor convivem.

ALTER TABLE "Marketplace" ADD COLUMN "provider" "MarketplaceProvider";

UPDATE "Marketplace" SET "provider" = 'MERCADO_LIVRE'
  WHERE lower(btrim("code")) IN ('mercado_livre', 'mercadolivre');
UPDATE "Marketplace" SET "provider" = 'SHOPEE'
  WHERE lower(btrim("code")) = 'shopee';
UPDATE "Marketplace" SET "provider" = 'OLX'
  WHERE lower(btrim("code")) = 'olx';
UPDATE "Marketplace" SET "provider" = 'SEBO_ONLINE'
  WHERE lower(btrim("code")) IN ('sebo', 'sebo_online');

-- Um canal por provedor por organização. Se algum dia houver duplicata, esta
-- criação falha e a migração para -- que é melhor que escolher em silêncio
-- qual dos dois canais recebe os pedidos do provedor.
CREATE UNIQUE INDEX "Marketplace_organizationId_provider_key"
  ON "Marketplace"("organizationId", "provider");

CREATE TABLE "MarketplaceSetting" (
    "id" TEXT NOT NULL,
    "marketplaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "secret" BOOLEAN NOT NULL DEFAULT false,
    "lookupHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarketplaceSetting_marketplaceId_key_key"
  ON "MarketplaceSetting"("marketplaceId", "key");
CREATE INDEX "MarketplaceSetting_marketplaceId_idx"
  ON "MarketplaceSetting"("marketplaceId");
CREATE INDEX "MarketplaceSetting_lookupHash_idx"
  ON "MarketplaceSetting"("lookupHash");

ALTER TABLE "MarketplaceSetting"
  ADD CONSTRAINT "MarketplaceSetting_marketplaceId_fkey"
  FOREIGN KEY ("marketplaceId") REFERENCES "Marketplace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
