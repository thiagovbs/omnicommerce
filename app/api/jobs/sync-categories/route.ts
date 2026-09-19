import { prisma } from "@/lib/prisma";
import { handleDispatchJob } from "@/lib/messaging/job-handlers";
import { syncAllCategories } from "@/lib/services/categories";

export const runtime = "nodejs";
// A árvore do Mercado Livre são ~29 MB por canal, e podem ser vários.
export const maxDuration = 300;

// Rede de segurança: se a importação que roda depois da autorização não
// completar, esta rota a refaz. Não há agendamento — categoria muda pouco, e
// a importação só acontece quando a árvore está ausente ou vencida.
export async function POST(request: Request) {
  return handleDispatchJob(request, () => syncAllCategories(prisma));
}

export async function GET(request: Request) { return POST(request); }
