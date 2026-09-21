-- Dados cadastrais da organização: razão social, CNPJ, contato e endereço.
--
-- Saem do ambiente e passam a morar aqui porque são de UMA organização, e o
-- mesmo deploy atende várias -- uma variável de ambiente serviria a todas ao
-- mesmo tempo. Quem lê, lê pela organização do usuário logado.
--
-- Todas com padrão vazio: organização existente continua válida, e quem exige
-- o dado é quem o usa (o anúncio da OLX, por exemplo), nomeando o que falta.
ALTER TABLE "Organization"
  ADD COLUMN "legalName"  TEXT NOT NULL DEFAULT '',
  ADD COLUMN "taxId"      TEXT NOT NULL DEFAULT '',
  ADD COLUMN "email"      TEXT NOT NULL DEFAULT '',
  ADD COLUMN "phone"      TEXT NOT NULL DEFAULT '',
  ADD COLUMN "zipCode"    TEXT NOT NULL DEFAULT '',
  ADD COLUMN "street"     TEXT NOT NULL DEFAULT '',
  ADD COLUMN "number"     TEXT NOT NULL DEFAULT '',
  ADD COLUMN "complement" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "district"   TEXT NOT NULL DEFAULT '',
  ADD COLUMN "city"       TEXT NOT NULL DEFAULT '',
  ADD COLUMN "state"      TEXT NOT NULL DEFAULT '';
