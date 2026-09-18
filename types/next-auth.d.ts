import type { UserRole } from "@prisma/client";

// Auth.js declares these interfaces in @auth/core; next-auth only re-exports them,
// so the augmentation has to target the modules that own the declarations.
// Session.user is this same User interface (DefaultSession["user"]?: User).
declare module "@auth/core/types" {
  interface User {
    organizationId: string;
    role: UserRole;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id: string;
    organizationId: string;
    role: UserRole;
  }
}
