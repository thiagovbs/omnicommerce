-- Histórico de tentativas de um evento de integração.
--
-- `IntegrationEvent.lastError` guarda só a ÚLTIMA falha e sobrescreve as
-- anteriores: um evento que falhou oito vezes por motivos diferentes mostrava
-- apenas o motivo da oitava. E falha transitória gravava o código genérico
-- `PROCESSING_FAILED`, perdendo a razão real -- então "por que este pedido não
-- entrou?" não tinha resposta no sistema.
--
-- A tabela é aditiva: nada do que existe muda, e evento antigo simplesmente não
-- tem histórico (o que é verdade -- ele nunca foi registrado).

CREATE TYPE "AttemptKind" AS ENUM ('PROCESSING', 'DELIVERY');
CREATE TYPE "AttemptOutcome" AS ENUM ('OK', 'TRANSIENT', 'PERMANENT');

CREATE TABLE "IntegrationEventAttempt" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" "AttemptKind" NOT NULL,
    "outcome" "AttemptOutcome" NOT NULL,
    "error" TEXT,
    "errorClass" TEXT,
    "durationMs" INTEGER,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationEventAttempt_pkey" PRIMARY KEY ("id")
);

-- A leitura é sempre "as tentativas deste evento, em ordem".
CREATE INDEX "IntegrationEventAttempt_eventId_at_idx"
  ON "IntegrationEventAttempt"("eventId", "at");

-- Cascade: histórico de evento apagado não tem a quem servir.
ALTER TABLE "IntegrationEventAttempt"
  ADD CONSTRAINT "IntegrationEventAttempt_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "IntegrationEvent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
