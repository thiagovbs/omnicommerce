import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { OrganizationForm } from "./organization-form";
import { Building2, Trash2 } from "lucide-react";
import { deleteOrganization } from "./actions";

export default async function OrganizationsPage() {
  const session = await auth();
  if ((session?.user as any)?.role !== "ADMIN") redirect("/dashboard");

  const organizations = await prisma.organization.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { users: true, sales: true } } }
  });

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold">Organizações</h1>
          <p className="text-gray-500">Gerencie as empresas que utilizam o sistema.</p>
        </div>
        <OrganizationForm />
      </div>

      <div className="bg-white border rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-6 py-4 text-sm font-semibold">Nome da Empresa</th>
              <th className="px-6 py-4 text-sm font-semibold text-center">Usuários</th>
              <th className="px-6 py-4 text-sm font-semibold text-center">Vendas</th>
              <th className="px-6 py-4 text-sm font-semibold text-right">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {organizations.map((org) => (
              <tr key={org.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 flex items-center gap-3">
                  <Building2 className="text-gray-400" size={20} />
                  <span className="font-medium">{org.name}</span>
                </td>
                <td className="px-6 py-4 text-center text-sm text-gray-500">{org._count.users}</td>
                <td className="px-6 py-4 text-center text-sm text-gray-500">{org._count.sales}</td>
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-2">
                    <OrganizationForm defaultValues={org} />
                    <form action={async () => { "use server"; await deleteOrganization(org.id); }}>
                      <button className="p-2 text-gray-400 hover:text-red-600"><Trash2 size={18} /></button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}