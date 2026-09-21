import "server-only";
import { timingSafeEqual } from "node:crypto";
import { MarketplaceProvider, PrismaClient } from "@prisma/client";
import { OrderError } from "../domain/order-input";
import { readLimitedText } from "../http/limited-body";
import { recordOrderEvent } from "../services/integration-events";
import { canalPorSegredoDeWebhook, marketplaceSettings } from "../services/marketplaces";

export interface ParsedNotification {
  /// Pedido a consultar no provedor.
  orderId: string;
  /// Conta ou loja no provedor: resolve a conexão e, por ela, o tenant.
  externalAccountId: string;
  /// Identidade estável do aviso; um reenvio traz a mesma.
  externalEventId: string;
}

export interface NotificationHandler {
  provider: MarketplaceProvider;
  secret: string | undefined;
  /// Devolve null quando o aviso não interessa (tópico alheio, outra aplicação).
  parse: (body: unknown) => ParsedNotification | null;
  /// Conferência extra sobre o corpo CRU, para provedor que assina o aviso.
  /// Recebe o texto como chegou porque reserializar o JSON reordena chaves e
  /// invalidaria a assinatura por um motivo invisível.
  assinatura?: (corpoCru: string, request: Request) => boolean;
}

/**
 * Descobre de QUEM é o aviso, pelo segredo que veio na URL.
 *
 * O provedor chama a URL de webhook sem dizer a qual organização ela pertence,
 * e o segredo deixou de ser um só do deploy: agora cada canal tem o seu. Então
 * é o próprio segredo que identifica o tenant -- encontrado por hash, porque o
 * valor é guardado cifrado com IV aleatório e não serve para busca.
 *
 * Devolve `null` quando nenhum canal tem aquele segredo, e o chamador responde
 * 404 -- a mesma resposta do segredo errado, para não confirmar a existência
 * do endpoint a quem está adivinhando URL.
 */
export async function configDoAviso(
  db: PrismaClient, provider: MarketplaceProvider, segredoRecebido: string,
): Promise<{ marketplaceId: string; cfg: Record<string, string> } | null> {
  const canal = await canalPorSegredoDeWebhook(db, provider, segredoRecebido);
  if (!canal) return null;
  return {
    marketplaceId: canal.marketplaceId,
    cfg: await marketplaceSettings(db, canal.marketplaceId),
  };
}

function authorized(supplied: string, expected: string | undefined) {
  if (!expected || expected.length < 32) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Recepção comum a todos os provedores: autentica, valida, resolve a conexão e grava
// o aviso cru com a pendência de publicação. Não consulta pedido nem aplica regra de
// negócio — quem faz isso é o job, depois da fila.
export async function handleProviderNotification(
  db: PrismaClient, request: Request, suppliedSecret: string, handler: NotificationHandler,
) {
  // 404 em vez de 401: não confirma a existência do endpoint para quem adivinha a URL.
  if (!authorized(suppliedSecret, handler.secret)) return new Response("Not found", { status: 404 });

  let cru: string;
  try {
    cru = await readLimitedText(request, 8192);
  } catch {
    return Response.json({ error: "Aviso inválido." }, { status: 400 });
  }
  // Mesma resposta do segredo errado, pelo mesmo motivo: não confirma a
  // existência do endpoint para quem está tentando adivinhar.
  if (handler.assinatura && !handler.assinatura(cru, request)) {
    return new Response("Not found", { status: 404 });
  }

  let body: unknown;
  let parsed: ParsedNotification | null;
  try {
    body = JSON.parse(cru);
    parsed = handler.parse(body);
  } catch (error) {
    return Response.json({ error: error instanceof OrderError ? error.message : "Aviso inválido." }, { status: 400 });
  }
  // Confirmado e descartado: 200 evita reenvio indefinido de algo que não nos serve.
  if (!parsed) return Response.json({ status: "ignored" });

  try {
    const connection = await db.marketplaceConnection.findFirst({
      where: { provider: handler.provider, externalAccountId: parsed.externalAccountId, status: "ACTIVE" },
      select: { id: true, marketplaceId: true },
    });
    if (!connection) return Response.json({ status: "ignored" });
    await recordOrderEvent(db, {
      marketplaceId: connection.marketplaceId,
      connectionId: connection.id,
      externalEventId: parsed.externalEventId,
      externalOrderId: parsed.orderId,
      // Guarda o aviso como chegou: o que foi derivado dele vive nas colunas.
      payload: body,
    });
    return Response.json({ status: "queued" });
  } catch (error) {
    if (error instanceof OrderError) return Response.json({ error: error.message }, { status: 400 });
    // 500 faz o provedor reenviar: o aviso ainda não está durável.
    return Response.json({ error: "Falha temporária na recepção." }, { status: 500 });
  }
}
