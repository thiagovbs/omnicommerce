import "server-only";
import { Prisma } from "@prisma/client";
import { OrderError } from "../domain/order-input";

/**
 * Quem está agindo, e a conferência de que ele existe naquela organização.
 *
 * Mora num módulo só seu, e não junto das vendas, porque quase todo serviço
 * precisa disso: com ele em `sales.ts`, qualquer serviço que as vendas também
 * usassem fechava um ciclo de importação.
 */
export type UserActor = { userId: string; organizationId: string };

export async function assertActor(tx: Prisma.TransactionClient, actor: UserActor) {
  if (!actor.userId || !actor.organizationId || !await tx.user.findFirst({
    where: { id: actor.userId, organizationId: actor.organizationId }, select: { id: true },
  })) throw new OrderError("Não autorizado.");
}
