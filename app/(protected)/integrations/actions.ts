"use server";
import { revalidatePath } from "next/cache";
import { currentActor } from "@/lib/current-actor";
import { prisma } from "@/lib/prisma";
import { OrderError } from "@/lib/domain/order-input";
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
