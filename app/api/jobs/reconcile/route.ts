import { prisma } from "@/lib/prisma";
import { providerLister } from "@/lib/integrations/reconcile";
import { handleDispatchJob } from "@/lib/messaging/job-handlers";
import { reconcileAll } from "@/lib/services/reconciliation";

export const runtime = "nodejs";
export const maxDuration = 60;

// Mesma autenticação do dispatcher: agendador externo com o CRON_SECRET.
export async function POST(request: Request) {
  return handleDispatchJob(request, () => reconcileAll(prisma, providerLister()));
}

export async function GET(request: Request) { return POST(request); }
