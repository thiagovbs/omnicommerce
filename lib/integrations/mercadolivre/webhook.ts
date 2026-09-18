import "server-only";
import { PrismaClient } from "@prisma/client";
import { handleProviderNotification } from "../webhook";
import { parseNotification } from "./notification";

// O Mercado Livre espera confirmação em até 500 ms.
export async function handleMercadoLivreNotification(db: PrismaClient, request: Request, secret: string) {
  return handleProviderNotification(db, request, secret, {
    provider: "MERCADO_LIVRE",
    secret: process.env.MERCADO_LIVRE_WEBHOOK_SECRET,
    parse: (body) => {
      const notification = parseNotification(body);
      const appId = process.env.MERCADO_LIVRE_APP_ID;
      if (notification.topic !== "orders_v2") return null;
      if (appId && notification.applicationId !== appId) return null;
      return {
        orderId: notification.orderId,
        externalAccountId: notification.externalAccountId,
        externalEventId: notification.externalEventId,
      };
    },
  });
}
