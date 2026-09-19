import { prisma } from "@/lib/prisma";
import { providerPublisher } from "@/lib/integrations/publish";
import { handleDispatchJob } from "@/lib/messaging/job-handlers";
import { syncListings } from "@/lib/services/listings";

export const runtime = "nodejs";
export const maxDuration = 60;

// Mesma autenticação do dispatcher: agendador externo com o CRON_SECRET.
// O lote é pequeno de propósito — cada anúncio é uma chamada ao provedor, e a
// função tem 60 segundos.
export async function POST(request: Request) {
  return handleDispatchJob(request, () => syncListings(prisma, providerPublisher(prisma), 10));
}

export async function GET(request: Request) { return POST(request); }
