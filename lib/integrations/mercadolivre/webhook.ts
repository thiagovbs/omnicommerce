import "server-only";
import { timingSafeEqual } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { OrderError } from "../../domain/order-input";
import { readLimitedText } from "../../http/limited-body";
import { recordOrderEvent } from "../../services/integration-events";
import { parseNotification } from "./notification";

function authorized(supplied: string) {
  const secret = process.env.MERCADO_LIVRE_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// O Mercado Livre espera confirmação em até 500 ms: aqui só grava o aviso e a pendência
// de publicação. Nada de consultar pedido, renovar token ou aplicar regra de negócio.
export async function handleMercadoLivreNotification(db: PrismaClient, request: Request, secret: string) {
  // 404 em vez de 401: não confirma a existência do endpoint para quem adivinha a URL.
  if (!authorized(secret)) return new Response("Not found", { status: 404 });

  let body: unknown;
  let notification;
  try {
    body = JSON.parse(await readLimitedText(request, 8192));
    notification = parseNotification(body);
  } catch (error) {
    return Response.json({ error: error instanceof OrderError ? error.message : "Aviso inválido." }, { status: 400 });
  }

  // Confirmado e descartado: não há o que fazer, e 200 evita reenvio indefinido.
  const appId = process.env.MERCADO_LIVRE_APP_ID;
  if (notification.topic !== "orders_v2" || (appId && notification.applicationId !== appId)) {
    return Response.json({ status: "ignored" });
  }

  try {
    const connection = await db.marketplaceConnection.findFirst({
      where: { provider: "MERCADO_LIVRE", externalAccountId: notification.externalAccountId, status: "ACTIVE" },
      select: { id: true, marketplaceId: true },
    });
    if (!connection) return Response.json({ status: "ignored" });
    await recordOrderEvent(db, {
      marketplaceId: connection.marketplaceId,
      connectionId: connection.id,
      externalEventId: notification.externalEventId,
      externalOrderId: notification.orderId,
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
