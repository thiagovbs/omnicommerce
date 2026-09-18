-- Platform operators administer organizations; tenant ADMIN stays scoped to its own organization.
-- Appended last so the database order matches the enum declared in schema.prisma.
ALTER TYPE "UserRole" ADD VALUE 'PLATFORM_ADMIN';
