-- Atributos de categoria do provedor: o que quem cadastra preencheu e o que
-- foi efetivamente enviado.
--
-- `attributes` é o desejado; `publishedAttributes` é o enviado, legível, e
-- inclui o que derivamos do produto (marca, modelo, motivo de GTIN vazio).
-- Essa diferença é o que costuma explicar uma recusa do provedor -- a
-- impressão em `publishedFingerprint` decide o trabalho, mas não conta o que
-- aconteceu.
--
-- Só os atributos, e não o payload inteiro: ele carregaria as imagens em
-- base64.
ALTER TABLE "Listing" ADD COLUMN     "attributes" JSONB,
ADD COLUMN     "publishedAttributes" JSONB;
