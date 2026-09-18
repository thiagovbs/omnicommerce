"use server";
import { prisma } from "@/lib/prisma";
import { currentActor } from "@/lib/current-actor";
import { objectInput, OrderError, textInput } from "@/lib/domain/order-input";
import { isOrgAdmin } from "@/lib/domain/roles";
import { revalidatePath } from "next/cache";

export async function getMarketplaces() {
  const actor = await currentActor();
  return prisma.marketplace.findMany({ where: { organizationId: actor.organizationId }, orderBy: { name: "asc" } });
}

export async function upsertMarketplace(input: unknown) {
  const actor = await currentActor();
  if (!isOrgAdmin(actor.role)) throw new OrderError("Apenas administradores podem configurar marketplaces.");
  const data = objectInput(input);
  if (data.organizationId !== undefined && data.organizationId !== actor.organizationId) throw new OrderError("Organização inválida.");
  const name = textInput(data.name, "Nome");
  const code = textInput(data.code, "Código", 100);
  if (!/^[a-z0-9_-]+$/.test(code) || typeof data.active !== "boolean") throw new OrderError("Dados do marketplace inválidos.");
  const payload = { name, code, active: data.active };
  if (data.id) {
    const id = textInput(data.id, "Marketplace");
    await prisma.marketplace.update({ where: { id, organizationId: actor.organizationId }, data: payload });
  } else {
    await prisma.marketplace.create({ data: { ...payload, organizationId: actor.organizationId } });
  }
  revalidatePath("/marketplaces");
}

export async function deleteMarketplace(id: string) {
  const actor = await currentActor();
  if (!isOrgAdmin(actor.role)) throw new OrderError("Apenas administradores podem configurar marketplaces.");
  textInput(id, "Marketplace");
  await prisma.marketplace.delete({ where: { id, organizationId: actor.organizationId } });
  revalidatePath("/marketplaces");
}
