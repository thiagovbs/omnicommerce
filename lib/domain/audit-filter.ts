import { Prisma } from "@prisma/client";

export interface AuditFilterInput {
  user?: string | null;
  action?: string | null;
  start?: string | null;
  end?: string | null;
}

function text(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// An unparseable date would otherwise reach Prisma as Invalid Date and fail the request.
function date(value: string | null | undefined) {
  const parsed = text(value) ? new Date(text(value) as string) : undefined;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

// Shared by the audit page and its PDF export so both apply exactly the same filter.
export function auditFilter(organizationId: string, input: AuditFilterInput): Prisma.AuditLogWhereInput {
  const user = text(input.user);
  const action = text(input.action);
  const gte = date(input.start);
  const lte = date(input.end);
  return {
    organizationId,
    ...(user ? { user: { name: { contains: user, mode: "insensitive" } } } : {}),
    ...(action ? { action } : {}),
    ...(gte || lte ? { createdAt: { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } } : {}),
  };
}
