import { prisma } from "@/lib/prisma";
import { providerResolver } from "@/lib/integrations/resolve";
import { processOrderEvent } from "@/lib/services/integration-events";
import { handleOrderJob } from "@/lib/messaging/job-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleOrderJob(request, (eventId) => processOrderEvent(prisma, eventId, providerResolver(prisma)));
}
