import { prisma } from "@/lib/prisma";
import { UserForm } from "./user-form";
import { Shield, User as UserIcon, Trash2 } from "lucide-react";
import { deleteUser } from "./actions";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const session = await auth();

  // 1. Verificação de Role e Organização do usuário logado
  const userRole = (session?.user as any)?.role;
  const userOrgId = (session?.user as any)?.organizationId;

  if (userRole !== "ADMIN" || !userOrgId) {
    redirect("/dashboard");
  }

  // 2. Buscamos os usuários da org atual, os dados da org atual e TODAS as organizações
  // Adicionamos 'allOrganizations' para popular o seletor no formulário
  const [users, currentOrg, allOrganizations] = await Promise.all([
    prisma.user.findMany({
      where: { organizationId: userOrgId },
      orderBy: { name: "asc" }
    }),
    prisma.organization.findUnique({
      where: { id: userOrgId }
    }),
    prisma.organization.findMany({ // Nova busca para o seletor
      orderBy: { name: "asc" }
    })
  ]);

  if (!currentOrg) return <div>Organização não encontrada.</div>;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold">Equipe</h1>
          <p className="text-gray-500">Gerencie quem tem acesso à {currentOrg.name}.</p>
        </div>
        {/* ALTERAÇÃO: Passamos a lista completa de organizações para o UserForm */}
        <UserForm organizations={allOrganizations} /> 
      </div>

      <div className="bg-white border rounded-xl shadow-sm">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-6 py-4 text-sm font-semibold">Usuário</th>
              <th className="px-6 py-4 text-sm font-semibold">Role</th>
              <th className="px-6 py-4 text-sm font-semibold text-right">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y text-sm">
            {users.map((user) => (
              <tr key={user.id} className="hover:bg-gray-50">
                <td className="px-6 py-4">
                  <div className="font-medium text-gray-900">{user.name}</div>
                  <div className="text-gray-500">{user.email}</div>
                </td>
                <td className="px-6 py-4">
                  <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    user.role === 'ADMIN' ? 'bg-purple-100 text-purple-800' : 'bg-gray-100 text-gray-800'
                  }`}>
                    {user.role === 'ADMIN' ? <Shield size={12} /> : <UserIcon size={12} />}
                    {user.role}
                  </span>
                </td>
                <td className="px-6 py-4 text-right">
                  {user.id !== session?.user?.id && (
                    <form action={async () => { "use server"; await deleteUser(user.id); }}>
                      <button className="text-gray-400 hover:text-red-600 transition-colors">
                        <Trash2 size={18} />
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}