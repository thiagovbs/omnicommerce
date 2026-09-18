import { handleSeboNotification } from "@/lib/integrations/sebo/webhook";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function POST(request: Request, { params }: { params: Promise<{ secret: string }> }) {
  return handleSeboNotification(prisma, request, (await params).secret);
}
