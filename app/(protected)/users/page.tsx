import { redirect } from "next/navigation";
import { Shield, ShieldCheck, User as UserIcon } from "lucide-react";
import { currentActor } from "@/lib/current-actor";
import { isOrgAdmin, isPlatformAdmin } from "@/lib/domain/roles";
import { prisma } from "@/lib/prisma";
import { DeleteUserButton } from "./delete-user-button";
import { UserForm } from "./user-form";

export const dynamic = "force-dynamic";

const roleLabels: Record<string, string> = {
  PLATFORM_ADMIN: "Plataforma",
  ADMIN: "Administrador",
  OPERATOR: "Operador",
};

const roleStyles: Record<string, string> = {
  PLATFORM_ADMIN: "bg-amber-100 text-amber-800",
  ADMIN: "bg-purple-100 text-purple-800",
  OPERATOR: "bg-gray-100 text-gray-800",
};

function RoleIcon({ role }: { role: string }) {
  if (role === "PLATFORM_ADMIN") return <ShieldCheck size={12} />;
  if (role === "ADMIN") return <Shield size={12} />;
  return <UserIcon size={12} />;
}

export default async function UsersPage() {
  const actor = await currentActor();
  if (!isOrgAdmin(actor.role)) redirect("/dashboard");
  const platform = isPlatformAdmin(actor.role);

  // A platform operator manages every tenant; a tenant administrator only sees its own team.
  const [users, currentOrg, organizations] = await Promise.all([
    prisma.user.findMany({
      where: platform ? {} : { organizationId: actor.organizationId },
      orderBy: [{ organization: { name: "asc" } }, { name: "asc" }],
      select: { id: true, name: true, email: true, role: true, organization: { select: { name: true } } },
    }),
    prisma.organization.findUnique({ where: { id: actor.organizationId }, select: { name: true } }),
    platform ? prisma.organization.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }) : [],
  ]);

  if (!currentOrg) return <div className="p-8">Organização não encontrada.</div>;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold">Equipe</h1>
          <p className="text-gray-500">
            {platform
              ? "Gerencie o acesso de todas as organizações da plataforma."
              : `Gerencie quem tem acesso à ${currentOrg.name}.`}
          </p>
        </div>
        <UserForm
          organizations={organizations}
          canChooseOrganization={platform}
          canGrantPlatformAdmin={platform}
        />
      </div>

      <div className="bg-white border rounded-xl shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-4 py-3 sm:px-6 sm:py-4 text-sm font-semibold">Usuário</th>
                {platform && <th className="px-4 py-3 sm:px-6 sm:py-4 text-sm font-semibold">Organização</th>}
                <th className="px-4 py-3 sm:px-6 sm:py-4 text-sm font-semibold">Perfil</th>
                <th className="px-4 py-3 sm:px-6 sm:py-4 text-sm font-semibold text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y text-sm">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 sm:px-6 sm:py-4">
                    <div className="font-medium text-gray-900">{user.name}</div>
                    <div className="text-gray-500">{user.email}</div>
                  </td>
                  {platform && <td className="px-4 py-3 sm:px-6 sm:py-4 text-gray-500">{user.organization.name}</td>}
                  <td className="px-4 py-3 sm:px-6 sm:py-4">
                    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      roleStyles[user.role] ?? roleStyles.OPERATOR
                    }`}>
                      <RoleIcon role={user.role} />
                      {roleLabels[user.role] ?? user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 sm:px-6 sm:py-4 text-right">
                    {user.id !== actor.userId && <DeleteUserButton userId={user.id} userName={user.name} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
