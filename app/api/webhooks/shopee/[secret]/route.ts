import { handleShopeeNotification } from "@/lib/integrations/shopee/webhook";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function POST(request: Request, { params }: { params: Promise<{ secret: string }> }) {
  return handleShopeeNotification(prisma, request, (await params).secret);
}
