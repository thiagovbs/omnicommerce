import "server-only";
import { auth } from "./auth";
import { prisma } from "./prisma";
import { OrderError } from "./domain/order-input";

export async function currentActor() {
  const session = await auth();
  if (!session?.user?.id) throw new OrderError("Não autorizado.");
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, organizationId: true, role: true } });
  if (!user) throw new OrderError("Não autorizado.");
  return { userId: user.id, organizationId: user.organizationId, role: user.role };
}
