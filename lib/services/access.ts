import "server-only";
import { Prisma } from "@prisma/client";
import { OrderError } from "../domain/order-input";
import { isOrgAdmin, isPlatformAdmin, UserRoleName } from "../domain/roles";
import { assertActor, UserActor } from "./sales";

// The role is re-read from the database inside the transaction: a role supplied by the
// caller (session claim, form field) is never authoritative for an authorization decision.
export async function assertOrgAdmin(tx: Prisma.TransactionClient, actor: UserActor): Promise<UserRoleName> {
  await assertActor(tx, actor);
  const user = await tx.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { role: true } });
  if (!isOrgAdmin(user.role)) throw new OrderError("Apenas administradores podem executar esta operação.");
  return user.role;
}

// Only a platform operator may act outside its own organization, and only on one that exists.
export async function assertOrganizationAccess(
  tx: Prisma.TransactionClient, actorRole: UserRoleName, actor: UserActor, organizationId: string,
) {
  if (organizationId === actor.organizationId) return organizationId;
  if (!isPlatformAdmin(actorRole)) throw new OrderError("Organização inválida.");
  if (!await tx.organization.findUnique({ where: { id: organizationId }, select: { id: true } })) {
    throw new OrderError("Organização não encontrada.");
  }
  return organizationId;
}
