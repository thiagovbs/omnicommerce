import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import { objectInput, OrderError, textInput } from "../domain/order-input";
import { isOrgAdmin, isPlatformAdmin, isUserRole } from "../domain/roles";
import { assertOrganizationAccess, assertOrgAdmin } from "./access";
import { UserActor } from "./actor";
import { serializable } from "./transactions";

function emailInput(value: unknown) {
  const email = textInput(value, "E-mail", 254).toLowerCase();
  if (!/^[^\s@"]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) throw new OrderError("E-mail inválido.");
  return email;
}

// Not trimmed: spaces are legitimate password characters.
function passwordInput(value: unknown) {
  if (typeof value !== "string" || value.length < 12 || value.length > 200) {
    throw new OrderError("A senha deve ter entre 12 e 200 caracteres.");
  }
  return value;
}

function optionalId(value: unknown, label: string) {
  return value === undefined || value === null || value === "" ? null : textInput(value, label);
}

const visible = { id: true, name: true, email: true, role: true, organizationId: true } as const;

// An organization must never be left without somebody able to administer it.
async function assertRemainingAdmin(
  tx: Prisma.TransactionClient, target: { role: string; organizationId: string }, excludeId: string,
) {
  if (!isOrgAdmin(target.role)) return;
  const remaining = await tx.user.count({ where: {
    organizationId: target.organizationId, role: { in: ["ADMIN", "PLATFORM_ADMIN"] }, id: { not: excludeId },
  } });
  if (!remaining) throw new OrderError("A organização ficaria sem administrador.");
}

export async function upsertMember(db: PrismaClient, actor: UserActor, input: unknown) {
  const data = objectInput(input);
  const id = optionalId(data.id, "Usuário");
  const name = textInput(data.name, "Nome");
  const email = emailInput(data.email);
  const requestedOrganizationId = optionalId(data.organizationId, "Organização");
  const requestedRole = data.role === undefined || data.role === null || data.role === "" ? null : data.role;
  if (requestedRole !== null && !isUserRole(requestedRole)) throw new OrderError("Perfil inválido.");
  // Hashing is deliberately kept outside the serializable transaction.
  const passwordHash = data.password === undefined || data.password === null || data.password === ""
    ? null : await hash(passwordInput(data.password), 10);

  return serializable(db, async (tx) => {
    const actorRole = await assertOrgAdmin(tx, actor);
    if (isPlatformAdmin(requestedRole) && !isPlatformAdmin(actorRole)) {
      throw new OrderError("Apenas operadores da plataforma podem conceder esse perfil.");
    }

    if (!id) {
      if (!passwordHash) throw new OrderError("Defina uma senha para o novo usuário.");
      const role = requestedRole ?? "OPERATOR";
      const organizationId = await assertOrganizationAccess(
        tx, actorRole, actor, requestedOrganizationId ?? actor.organizationId,
      );
      const user = await tx.user.create({ data: { organizationId, name, email, role, passwordHash }, select: visible });
      await tx.auditLog.create({ data: {
        action: "CREATE", entity: "USER", entityId: user.id, organizationId, userId: actor.userId,
        details: `Usuário ${email} criado com perfil ${role}.`,
        newData: { name, email, role, organizationId },
      } });
      return { id: user.id };
    }

    const existing = await tx.user.findUnique({ where: { id }, select: visible });
    // An out-of-scope user must be indistinguishable from a missing one.
    if (!existing || (existing.organizationId !== actor.organizationId && !isPlatformAdmin(actorRole))) {
      throw new OrderError("Usuário não encontrado.");
    }
    if (isPlatformAdmin(existing.role) && !isPlatformAdmin(actorRole)) throw new OrderError("Usuário não encontrado.");
    const role = requestedRole ?? existing.role;
    if (existing.id === actor.userId && role !== existing.role) {
      throw new OrderError("Não é possível alterar o próprio perfil de acesso.");
    }
    const organizationId = await assertOrganizationAccess(
      tx, actorRole, actor, requestedOrganizationId ?? existing.organizationId,
    );
    if (organizationId !== existing.organizationId) {
      await assertOrganizationAccess(tx, actorRole, actor, existing.organizationId);
      if (existing.id === actor.userId) throw new OrderError("Não é possível mover o próprio usuário de organização.");
    }
    // Demoting or moving away the last administrator would lock the organization out.
    if (!isOrgAdmin(role) || organizationId !== existing.organizationId) {
      await assertRemainingAdmin(tx, existing, id);
    }
    const user = await tx.user.update({
      where: { id }, select: visible,
      data: { name, email, role, organizationId, ...(passwordHash ? { passwordHash } : {}) },
    });
    await tx.auditLog.create({ data: {
      action: "UPDATE", entity: "USER", entityId: id, organizationId, userId: actor.userId,
      details: `Usuário ${existing.email} atualizado${passwordHash ? " (senha redefinida)" : ""}.`,
      oldData: { name: existing.name, email: existing.email, role: existing.role, organizationId: existing.organizationId },
      newData: { name: user.name, email: user.email, role: user.role, organizationId: user.organizationId },
    } });
    return { id };
  });
}

export async function removeMember(db: PrismaClient, actor: UserActor, userId: unknown) {
  const id = textInput(userId, "Usuário");
  return serializable(db, async (tx) => {
    const actorRole = await assertOrgAdmin(tx, actor);
    if (id === actor.userId) throw new OrderError("Não é possível excluir o próprio usuário.");
    const target = await tx.user.findUnique({ where: { id }, select: visible });
    if (!target || (target.organizationId !== actor.organizationId && !isPlatformAdmin(actorRole))) {
      throw new OrderError("Usuário não encontrado.");
    }
    if (isPlatformAdmin(target.role) && !isPlatformAdmin(actorRole)) throw new OrderError("Usuário não encontrado.");
    await assertRemainingAdmin(tx, target, id);
    // Audit rows and status history keep the trail: both detach the user instead of cascading.
    await tx.user.delete({ where: { id } });
    await tx.auditLog.create({ data: {
      action: "DELETE", entity: "USER", entityId: id, organizationId: target.organizationId, userId: actor.userId,
      details: `Usuário ${target.email} excluído.`,
      oldData: { name: target.name, email: target.email, role: target.role, organizationId: target.organizationId },
    } });
  });
}
