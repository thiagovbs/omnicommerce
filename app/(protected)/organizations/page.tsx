import { redirect } from "next/navigation";
import { Building2 } from "lucide-react";
import { currentActor } from "@/lib/current-actor";
import { isOrgAdmin, isPlatformAdmin } from "@/lib/domain/roles";
import { prisma } from "@/lib/prisma";
import { DeleteOrganizationButton } from "./delete-organization-button";
import { OrganizationForm } from "./organization-form";

export const dynamic = "force-dynamic";

export default async function OrganizationsPage() {
  const actor = await currentActor();
  if (!isOrgAdmin(actor.role)) redirect("/dashboard");
  const platform = isPlatformAdmin(actor.role);

  // Only a platform operator sees other tenants; a tenant administrator sees its own organization.
  const organizations = await prisma.organization.findMany({
    where: platform ? {} : { id: actor.organizationId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, _count: { select: { users: true, sales: true, marketplaces: true } } },
  });

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold">Organizações</h1>
          <p className="text-gray-500">
            {platform
              ? "Gerencie as empresas que utilizam o sistema."
              : "Dados cadastrais da sua empresa."}
          </p>
        </div>
        {platform && <OrganizationForm />}
      </div>

      <div className="bg-white border rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-6 py-4 text-sm font-semibold">Nome da Empresa</th>
              <th className="px-6 py-4 text-sm font-semibold text-center">Usuários</th>
              <th className="px-6 py-4 text-sm font-semibold text-center">Marketplaces</th>
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
                  {org.id === actor.organizationId && (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">Sua empresa</span>
                  )}
                </td>
                <td className="px-6 py-4 text-center text-sm text-gray-500">{org._count.users}</td>
                <td className="px-6 py-4 text-center text-sm text-gray-500">{org._count.marketplaces}</td>
                <td className="px-6 py-4 text-center text-sm text-gray-500">{org._count.sales}</td>
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-2">
                    <OrganizationForm defaultValues={{ id: org.id, name: org.name }} />
                    {/* Deleting the organization you are signed in with would lock you out. */}
                    {platform && org.id !== actor.organizationId && (
                      <DeleteOrganizationButton organizationId={org.id} organizationName={org.name} />
                    )}
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
