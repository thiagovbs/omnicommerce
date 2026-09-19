-- O álbum substitui o campo único de imagem do produto.
--
-- A ordem aqui importa: o `migrate diff` gera o DROP COLUMN antes do CREATE
-- TABLE, o que descartaria a imagem de todo produto já cadastrado. A tabela
-- nasce primeiro, os valores existentes são copiados para a posição 0 -- que
-- é a principal -- e só então a coluna sai.

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductImage_productId_idx" ON "ProductImage"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductImage_productId_position_key" ON "ProductImage"("productId", "position");

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migra a imagem existente para a primeira posição do álbum. Produto sem
-- imagem não gera linha: álbum vazio é a ausência, não uma entrada em branco.
INSERT INTO "ProductImage" ("id", "productId", "position", "url")
SELECT gen_random_uuid()::text, "id", 0, "imageUrl"
FROM "Product"
WHERE "imageUrl" <> '';

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "imageUrl";
