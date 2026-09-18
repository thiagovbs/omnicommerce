import { prisma } from "@/lib/prisma";
import { dispatchOutbox } from "@/lib/services/outbox";
import { messagingConfig, qstashPublisher } from "@/lib/messaging/qstash";
import { handleDispatchJob } from "@/lib/messaging/job-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleDispatchJob(request, async () => ({
    ...(await dispatchOutbox(prisma, qstashPublisher(), 4)),
    // Destino assinado, derivado de APP_URL. Só quem tem o CRON_SECRET vê, e é
    // o que permite conferir de fora se a verificação de assinatura vai casar.
    destination: messagingConfig().destination,
  }));
}

// Compatible with an authenticated scheduler; no schedule is provisioned by this repository.
export async function GET(request: Request) { return POST(request); }
