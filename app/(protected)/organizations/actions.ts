"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";

async function checkAdmin() {
  const session = await auth();
  if ((session?.user as any)?.role !== "ADMIN") {
    throw new Error("Acesso negado.");
  }
}

export async function upsertOrganization(data: { id?: string; name: string }) {
  await checkAdmin();

  if (data.id) {
    await prisma.organization.update({
      where: { id: data.id },
      data: { name: data.name },
    });
  } else {
    await prisma.organization.create({
      data: { name: data.name },
    });
  }

  revalidatePath("/organizations");
}

export async function deleteOrganization(id: string) {
  await checkAdmin();
  // Nota: Isso falhará se houver usuários ou vendas vinculadas (Foreign Key)
  await prisma.organization.delete({ where: { id } });
  revalidatePath("/organizations");
}