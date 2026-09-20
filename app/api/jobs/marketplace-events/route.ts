import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { providerPublisher } from "@/lib/integrations/publish";
import { providerResolver } from "@/lib/integrations/resolve";
import { processOrderEvent } from "@/lib/services/integration-events";
import { pushAposVenda } from "@/lib/services/listings";
import { handleOrderJob } from "@/lib/messaging/job-handlers";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleOrderJob(request, async (eventId) => {
    const resultado = await processOrderEvent(prisma, eventId, providerResolver(prisma));

    // A venda pode ter baixado estoque, e os outros canais precisam saber
    // disso agora. Roda DEPOIS da resposta: a fila precisa receber o "entregue"
    // rápido, e publicar em provedor é lento. Nada aqui altera o resultado do
    // evento, que já está gravado.
    if (resultado === "PROCESSED") {
      after(() => pushAposVenda(prisma, providerPublisher(prisma), eventId));
    }
    return resultado;
  });
}
