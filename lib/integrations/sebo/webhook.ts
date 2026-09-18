import "server-only";
import { PrismaClient } from "@prisma/client";
import { handleProviderNotification } from "../webhook";
import { parseSeboNotification } from "./notification";

export async function handleSeboNotification(db: PrismaClient, request: Request, secret: string) {
  return handleProviderNotification(db, request, secret, {
    provider: "SEBO_ONLINE",
    secret: process.env.SEBO_WEBHOOK_SECRET,
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
