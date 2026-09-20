-- A impressão substitui o hash só das imagens.
--
-- Comparar campo a campo já divergiu duas vezes da lista do que se publica:
-- primeiro as imagens, depois o título. Nos dois casos o anúncio ficava
-- pendente, o trabalhador o dava como em dia, e a mudança nunca chegava ao
-- provedor -- sem erro nenhum.
--
-- A coluna nasce nula de propósito, inclusive para anúncios já publicados:
-- nula não casa com impressão nenhuma, então todo anúncio existente é
-- considerado desatualizado e vai ao provedor uma vez. É o comportamento
-- certo, porque não há como saber o que foi enviado antes desta coluna.

-- AlterTable
ALTER TABLE "Listing" DROP COLUMN "publishedImagesHash",
ADD COLUMN     "externalStatus" TEXT,
ADD COLUMN     "publishedFingerprint" TEXT;

