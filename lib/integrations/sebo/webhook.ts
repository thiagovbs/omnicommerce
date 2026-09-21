import "server-only";
import { PrismaClient } from "@prisma/client";
import { configDoAviso, handleProviderNotification } from "../webhook";
import { parseSeboNotification } from "./notification";

export async function handleSeboNotification(db: PrismaClient, request: Request, secret: string) {
  const canal = await configDoAviso(db, "SEBO_ONLINE", secret);
  if (!canal) return new Response("Not found", { status: 404 });

  return handleProviderNotification(db, request, secret, {
    provider: "SEBO_ONLINE",
    secret: canal.cfg.webhookSecret,
    parse: (body) => {
      const notification = parseSeboNotification(body);
      if (notification.topic !== "orders") return null;
      return {
        orderId: notification.orderId,
        externalAccountId: notification.storeId,
        externalEventId: notification.externalEventId,
      };
    },
  });
}
