import "server-only";
import { AttemptKind, AttemptOutcome, Prisma, PrismaClient } from "@prisma/client";
import { OrderError, textInput } from "../domain/order-input";
import { assertActor, UserActor } from "./actor";

/**
 * Histórico de um evento de integração: o que foi tentado, quando, e no que deu.
 *
 * Existe por uma pergunta que o sistema não sabia responder: "por que ESTE
 * pedido não entrou?". O evento guardava só `lastError`, sobrescrito a cada
 * tentativa -- e, quando a falha era transitória, guardava o código genérico
 * `PROCESSING_FAILED`, perdendo a razão real. Quem estava na tela via
 * "Requer atenção" e oito tentativas, sem nada que dissesse o que houve.
 *
 * ## O que pode ser registrado
 *
 * A regra é a mesma que o despacho da fila já aplicava, e vale repetir porque é
 * fácil de violar sem perceber: **mensagem de terceiro não entra**, porque pode
 * carregar cabeçalho, URL assinada ou credencial. Então:
 *
 * - `error` recebe a mensagem apenas quando o erro é NOSSO (`OrderError` e os
 *   erros de provedor, que carregam códigos que nós escrevemos, como
 *   `SEBO_UNAVAILABLE`).
 * - `errorClass` recebe sempre o nome da classe, que é seguro -- e é ele que
 *   separa `TypeError` (defeito nosso) de `ProviderTransientError` (o provedor
 *   caiu) de `PrismaClientKnownRequestError` (o banco recusou).
 *
 * ## Por que `error.name`, e não `error.constructor.name`
 *
 * Porque o build de produção é MINIFICADO. `constructor.name` devolvia o nome
 * encurtado da classe -- `"i"`, `"a"` --, que nunca casava com a lista abaixo:
 * o histórico gravava uma letra como classe e NENHUMA mensagem, justamente nos
 * erros que são nossos. O defeito não aparecia em teste nenhum, porque teste
 * roda sem minificar. `name` é declarado como texto em cada classe, e texto o
 * minificador não toca.
 *
 * Um dia em que isso for relaxado, o log vira um lugar onde credencial aparece
 * -- e credencial que apareceu precisa ser trocada no provedor.
 */

/// Limite do que se guarda de uma mensagem. O histórico é para ser lido na
/// tela; mensagem de dez mil caracteres não é diagnóstico, é despejo.
const LIMITE_MENSAGEM = 500;

/// Erros nossos: a mensagem deles é escrita por nós e pode ser mostrada.
/// `OrderError` é o erro de regra; os de provedor carregam códigos nossos.
const NOSSOS = new Set([
  "OrderError", "ProviderAuthError", "ProviderTransientError", "ProviderOrderGoneError",
  "OAuthConfigurationError", "OlxOAuthConfigurationError",
  "ShopeeConfigurationError", "SeboConfigurationError", "OlxConfigurationError",
  "FacebookConfigurationError", "FacebookOAuthConfigurationError",
  "SecretConfigurationError", "MessagingConfigurationError", "PartialPublishError",
]);

export interface TentativaRegistrada {
  eventId: string;
  number: number;
  kind: AttemptKind;
  outcome: AttemptOutcome;
  durationMs?: number;
  error?: unknown;
}

/**
 * Grava uma tentativa. Nunca lança.
 *
 * Falhar ao registrar histórico não pode derrubar o processamento: o histórico
 * serve para explicar o que aconteceu, e seria absurdo que ele impedisse a
 * coisa de acontecer.
 */
export async function registrarTentativa(
  db: PrismaClient | Prisma.TransactionClient, tentativa: TentativaRegistrada,
) {
  const { error } = tentativa;
  const classe = error instanceof Error ? error.name : undefined;
  const mensagem = error instanceof Error && classe && NOSSOS.has(classe)
    ? error.message.slice(0, LIMITE_MENSAGEM)
    : undefined;
  try {
    await db.integrationEventAttempt.create({ data: {
      eventId: tentativa.eventId,
      number: tentativa.number,
      kind: tentativa.kind,
      outcome: tentativa.outcome,
      error: mensagem ?? null,
      errorClass: classe ?? null,
      durationMs: tentativa.durationMs ?? null,
    } });
  } catch {
    // Sem rethrow, e sem log do erro original: ele pode ser o mesmo que
    // estávamos tentando registrar.
  }
}

/**
 * O evento com tudo o que se sabe dele, para a tela de histórico.
 *
 * Passa pela organização do ator -- um administrador não abre o evento de outra
 * organização nem por URL adivinhada.
 */
export async function eventHistory(db: PrismaClient, actor: UserActor, eventId: string) {
  const id = textInput(eventId, "Evento");
  await assertActor(db, actor);
  const evento = await db.integrationEvent.findFirst({
    where: { id, marketplace: { organizationId: actor.organizationId } },
    select: {
      id: true, externalEventId: true, externalOrderId: true, status: true,
      attempts: true, lastError: true, receivedAt: true, processedAt: true, payload: true,
      marketplace: { select: { name: true, provider: true } },
      connection: { select: { provider: true, externalAccountId: true, status: true } },
      outbox: {
        select: {
          status: true, attempts: true, lastError: true, availableAt: true,
          publishedAt: true, createdAt: true,
        },
      },
      attemptLog: {
        orderBy: { at: "asc" },
        select: {
          id: true, number: true, kind: true, outcome: true, error: true,
          errorClass: true, durationMs: true, at: true,
        },
      },
      auditLogs: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true, action: true, entity: true, details: true, createdAt: true,
          user: { select: { name: true, email: true } },
        },
      },
    },
  });
  if (!evento) throw new OrderError("Evento não encontrado.");
  return evento;
}
