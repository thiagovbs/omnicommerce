"use server";
import { revalidatePath } from "next/cache";
import { currentActor } from "@/lib/current-actor";
import { prisma } from "@/lib/prisma";
import { OrderError } from "@/lib/domain/order-input";
import { providerLister } from "@/lib/integrations/reconcile";
import { qstashPublisher } from "@/lib/messaging/qstash";
import { sincronizarAgora } from "@/lib/services/reconciliation";
import { requeueOrderEvent } from "@/lib/services/outbox";

export async function retryEvent(eventId: string) {
  try {
    await requeueOrderEvent(prisma, await currentActor(), eventId);
    revalidatePath("/integrations");
    revalidatePath("/audit");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof OrderError ? error.message : "Não foi possível reprocessar o evento." };
  }
}

/**
 * "Sincronizar agora": pergunta ao provedor o que mudou e esvazia a fila.
 *
 * Sem `connectionId`, vale para todas as contas ativas da organização.
 *
 * A autorização é a da sessão -- o serviço exige administrador da organização
 * e só enxerga as conexões dela. O `CRON_SECRET`, que abre as rotas do
 * agendador, não passa por aqui nem precisa estar na mão de ninguém.
 */
export async function sincronizarIntegracoes(connectionId?: string) {
  try {
    const resultado = await sincronizarAgora(
      prisma, await currentActor(), providerLister(prisma), qstashPublisher(),
      { connectionId },
    );
    revalidatePath("/integrations");
    revalidatePath("/sales");
    return { ok: true as const, resultado };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof OrderError ? error.message : "Não foi possível sincronizar agora.",
    };
  }
}
