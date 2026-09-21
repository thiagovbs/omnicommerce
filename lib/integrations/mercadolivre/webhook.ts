import "server-only";
import { PrismaClient } from "@prisma/client";
import { configDoAviso, handleProviderNotification } from "../webhook";
import { parseNotification } from "./notification";

// O Mercado Livre espera confirmação em até 500 ms.
export async function handleMercadoLivreNotification(db: PrismaClient, request: Request, secret: string) {
  // O segredo da URL é o que diz de qual canal -- e de qual organização -- é o
  // aviso. Era um só, do ambiente; agora é o do canal.
  const canal = await configDoAviso(db, "MERCADO_LIVRE", secret);
  if (!canal) return new Response("Not found", { status: 404 });

  return handleProviderNotification(db, request, secret, {
    provider: "MERCADO_LIVRE",
    secret: canal.cfg.webhookSecret,
    parse: (body) => {
      const notification = parseNotification(body);
      const appId = canal.cfg.appId;
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
