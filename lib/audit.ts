import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface AuditOptions {
  action: "CREATE" | "UPDATE" | "DELETE" | "LOGIN";
  entity: "SALE" | "USER" | "MARKETPLACE" | "ORGANIZATION";
  entityId: string;
  details?: string;
  oldData?: any;
  newData?: any;
}

export async function recordAudit(options: AuditOptions) {
  const session = await auth();

  // DEBUG: Verificar se a sessão está chegando na action
    if (!session) {
      console.error("❌ AUDIT_ERROR: Sessão não encontrada. Usuário pode não estar autenticado.");
      return;
    }
  
  const userId = session?.user?.id;
  const organizationId = (session?.user as any)?.organizationId;

  if (!userId || !organizationId) return; // Segurança: só loga se houver contexto

  return await prisma.auditLog.create({
    data: {
      action: options.action,
      entity: options.entity,
      entityId: options.entityId,
      details: options.details,
      oldData: options.oldData,
      newData: options.newData,
      userId,
      organizationId,
    },
  });
}