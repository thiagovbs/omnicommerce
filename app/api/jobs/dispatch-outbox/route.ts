import { prisma } from "@/lib/prisma";
import { dispatchOutbox } from "@/lib/services/outbox";
import { messagingConfig, qstashPublisher } from "@/lib/messaging/qstash";
import { handleDispatchJob } from "@/lib/messaging/job-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleDispatchJob(request, async () => ({
    // Vinte por rodada, e não quatro. Quatro a cada cinco minutos são 48 por
    // hora: um provedor que volta do ar despeja o acúmulo dele de uma vez, e a
    // venda recém-feita ficava uma hora atrás de avisos velhos -- foi o que
    // aconteceu com 46 avisos do Sebo. Vinte publicações são alguns segundos
    // dos 60 desta rota.
    ...(await dispatchOutbox(prisma, qstashPublisher(), 20)),
    // Destino assinado, derivado de APP_URL. Só quem tem o CRON_SECRET vê, e é
    // o que permite conferir de fora se a verificação de assinatura vai casar.
    destination: messagingConfig().destination,
  }));
}

// Compatible with an authenticated scheduler; no schedule is provisioned by this repository.
export async function GET(request: Request) { return POST(request); }
