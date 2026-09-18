export const userRoles = ["ADMIN", "OPERATOR", "PLATFORM_ADMIN"] as const;

export type UserRoleName = (typeof userRoles)[number];

export function isUserRole(value: unknown): value is UserRoleName {
  return typeof value === "string" && userRoles.some((role) => role === value);
}

/// Operators of the platform itself: the only role allowed to cross organization boundaries.
export function isPlatformAdmin(role: unknown) {
  return role === "PLATFORM_ADMIN";
}

/// Administrators of a single tenant. Platform operators also administer their own organization.
export function isOrgAdmin(role: unknown) {
  return role === "ADMIN" || isPlatformAdmin(role);
}
