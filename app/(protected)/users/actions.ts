"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { currentActor } from "@/lib/current-actor";
import { OrderError } from "@/lib/domain/order-input";
import { prisma } from "@/lib/prisma";
import { removeMember, upsertMember } from "@/lib/services/members";

function failure(error: unknown) {
  if (error instanceof OrderError) return { ok: false as const, error: error.message };
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return { ok: false as const, error: "Já existe um usuário com esse e-mail." };
  }
  return { ok: false as const, error: "Não foi possível salvar. Tente novamente." };
}

function refreshUsers() {
  for (const path of ["/users", "/audit"]) revalidatePath(path);
}

export async function upsertUser(data: unknown) {
  try {
    const user = await upsertMember(prisma, await currentActor(), data);
    refreshUsers();
    return { ok: true as const, user };
  } catch (error) { return failure(error); }
}

export async function deleteUser(id: string) {
  try {
    await removeMember(prisma, await currentActor(), id);
    refreshUsers();
    return { ok: true as const };
  } catch (error) { return failure(error); }
}
