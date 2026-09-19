import "server-only";
import { PrismaClient } from "@prisma/client";
import { objectInput, OrderError, textInput } from "../domain/order-input";
import { isPlatformAdmin } from "../domain/roles";
import { assertOrganizationAccess, assertOrgAdmin } from "./access";
import { UserActor } from "./actor";
import { serializable } from "./transactions";

export async function upsertOrganization(db: PrismaClient, actor: UserActor, input: unknown) {
  const data = objectInput(input);
  const id = data.id === undefined || data.id === null || data.id === "" ? null : textInput(data.id, "Organização");
  const name = textInput(data.name, "Nome");
  return serializable(db, async (tx) => {
    const actorRole = await assertOrgAdmin(tx, actor);
    if (!id) {
      if (!isPlatformAdmin(actorRole)) throw new OrderError("Apenas operadores da plataforma podem criar organizações.");
      const organization = await tx.organization.create({ data: { name } });
      await tx.auditLog.create({ data: {
        action: "CREATE", entity: "ORGANIZATION", entityId: organization.id, organizationId: organization.id,
        userId: actor.userId, details: `Organização ${name} criada.`, newData: { name },
      } });
      return { id: organization.id };
    }
    await assertOrganizationAccess(tx, actorRole, actor, id);
    const existing = await tx.organization.findUnique({ where: { id }, select: { name: true } });
    if (!existing) throw new OrderError("Organização não encontrada.");
    await tx.organization.update({ where: { id }, data: { name } });
    await tx.auditLog.create({ data: {
      action: "UPDATE", entity: "ORGANIZATION", entityId: id, organizationId: id, userId: actor.userId,
      details: `Organização renomeada de ${existing.name} para ${name}.`,
      oldData: { name: existing.name }, newData: { name },
    } });
    return { id };
  });
}

export async function removeOrganization(db: PrismaClient, actor: UserActor, organizationId: unknown) {
  const id = textInput(organizationId, "Organização");
  return serializable(db, async (tx) => {
    const actorRole = await assertOrgAdmin(tx, actor);
    if (!isPlatformAdmin(actorRole)) throw new OrderError("Apenas operadores da plataforma podem excluir organizações.");
    if (id === actor.organizationId) throw new OrderError("Não é possível excluir a própria organização.");
    const organization = await tx.organization.findUnique({
      where: { id }, select: { name: true, _count: { select: { users: true, sales: true, marketplaces: true } } },
    });
    if (!organization) throw new OrderError("Organização não encontrada.");
    // Users, marketplaces and sales cascade on delete; require an empty organization instead of
    // destroying tenant data as a side effect of renaming a row.
    const { users, sales, marketplaces } = organization._count;
    if (users || sales || marketplaces) {
      throw new OrderError("Remova usuários, marketplaces e vendas antes de excluir a organização.");
    }
    await tx.organization.delete({ where: { id } });
    // Recorded under the actor's organization: rows of the removed one are cascade-deleted.
    await tx.auditLog.create({ data: {
      action: "DELETE", entity: "ORGANIZATION", entityId: id, organizationId: actor.organizationId,
      userId: actor.userId, details: `Organização ${organization.name} excluída.`, oldData: { name: organization.name },
    } });
  });
}
