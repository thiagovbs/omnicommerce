"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { hash } from "bcryptjs";
import { UserRole } from "@prisma/client";

async function checkAdmin() {
  const session = await auth();
  if ((session?.user as any)?.role !== "ADMIN") {
    throw new Error("Acesso negado: Somente administradores.");
  }
  return session;
}

export async function getUsers(organizationId: string) {
  await checkAdmin(); // Valida antes de qualquer operação
  return await prisma.user.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    }
  });
}

export async function upsertUser(data: any) {
  const { id, name, email, password, role, organizationId } = data;

  if (id) {
    // Edição
    await prisma.user.update({
      where: { id },
      data: { 
        name, 
        email, 
        role, 
        organizationId 
      },
    });
  } else {
    // Criação
    const passwordHash = await hash(password || "Padrao123!", 10);
    await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        role,
        organizationId,
      },
    });
  }

  revalidatePath("/users");
}

export async function deleteUser(id: string) {
  await checkAdmin(); // Valida antes de qualquer operação
  await prisma.user.delete({ where: { id } });
  revalidatePath("/users");
}