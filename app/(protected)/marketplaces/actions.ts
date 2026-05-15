"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

// Função para buscar marketplaces (Read)
export async function getMarketplaces(organizationId: string) {
  return await prisma.marketplace.findMany({
    where: { organizationId },
    orderBy: { name: "asc" },
  });
}

// Função para criar ou atualizar (Upsert)
export async function upsertMarketplace(data: {
  id?: string;
  organizationId: string;
  name: string;
  code: string;
  active: boolean;
}) {
  const { id, ...payload } = data;

  if (id) {
    await prisma.marketplace.update({
      where: { id },
      data: payload,
    });
  } else {
    await prisma.marketplace.create({
      data: payload,
    });
  }

  revalidatePath("/marketplaces");
}

// Função para deletar (Delete)
export async function deleteMarketplace(id: string) {
  await prisma.marketplace.delete({
    where: { id },
  });
  revalidatePath("/marketplaces");
}