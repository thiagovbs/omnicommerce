import { prisma } from "@/lib/prisma";
import { dispatchOutbox } from "@/lib/services/outbox";
import { qstashPublisher } from "@/lib/messaging/qstash";
import { handleDispatchJob } from "@/lib/messaging/job-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleDispatchJob(request, () => dispatchOutbox(prisma, qstashPublisher(), 4));
}

// Compatible with an authenticated scheduler; no schedule is provisioned by this repository.
export async function GET(request: Request) { return POST(request); }
