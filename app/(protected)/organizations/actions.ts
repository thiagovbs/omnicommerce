"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { currentActor } from "@/lib/current-actor";
import { OrderError } from "@/lib/domain/order-input";
import { prisma } from "@/lib/prisma";
import { removeOrganization, upsertOrganization as upsert } from "@/lib/services/organizations";

function failure(error: unknown) {
  if (error instanceof OrderError) return { ok: false as const, error: error.message };
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
    return { ok: false as const, error: "A organização ainda possui registros vinculados." };
  }
  return { ok: false as const, error: "Não foi possível salvar. Tente novamente." };
}

function refreshOrganizations() {
  for (const path of ["/organizations", "/users", "/audit"]) revalidatePath(path);
}

export async function upsertOrganization(data: unknown) {
  try {
    const organization = await upsert(prisma, await currentActor(), data);
    refreshOrganizations();
    return { ok: true as const, organization };
  } catch (error) { return failure(error); }
}

export async function deleteOrganization(id: string) {
  try {
    await removeOrganization(prisma, await currentActor(), id);
    refreshOrganizations();
    return { ok: true as const };
  } catch (error) { return failure(error); }
}
