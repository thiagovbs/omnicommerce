import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { History, User as UserIcon, Tag, Info, FileDown, Search } from "lucide-react";
import { AuditDetailModal } from "./audit-detail-modal";

export const dynamic = "force-dynamic";

// Recebemos searchParams para filtrar no banco de dados
export default async function AuditPage({
  searchParams,
}: {
  searchParams: { user?: string; start?: string; end?: string; action?: string };
}) {
  const session = await auth();
  const organizationId = (session?.user as any)?.organizationId;

  if ((session?.user as any)?.role !== "ADMIN") {
    redirect("/dashboard");
  }

  // Construção do filtro dinâmico para o Prisma
  const where: any = { organizationId };

  if (searchParams.user) {
    where.user = { name: { contains: searchParams.user, mode: 'insensitive' } };
  }

  if (searchParams.action) {
    where.action = searchParams.action;
  }

  if (searchParams.start || searchParams.end) {
    where.createdAt = {};
    if (searchParams.start) where.createdAt.gte = new Date(searchParams.start);
    if (searchParams.end) where.createdAt.lte = new Date(searchParams.end);
  }

  const [logs, users] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.user.findMany({ where: { organizationId }, select: { name: true } })
  ]);

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div className="flex items-center gap-3">
          <div className="bg-slate-100 p-3 rounded-xl">
            <History className="text-slate-600" size={28} />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Log de Auditoria</h1>
            <p className="text-gray-500 text-sm">Rastreamento de todas as alterações realizadas no sistema.</p>
          </div>
        </div>

        
        <a 
          href="/api/reports/audit" 
          target="_blank" 
          className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-lg flex items-center justify-center gap-2 hover:bg-gray-50 transition-all font-medium shadow-sm text-sm h-fit"
        >
          <FileDown size={16} /> Exportar Logs (PDF)
        </a>
      </div>

      {/* SEGUNDA LINHA: FILTROS (Formulário Simples) */}
      <form className="bg-white p-4 border rounded-xl shadow-sm grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Usuário</label>
          <input 
            name="user"
            defaultValue={searchParams.user}
            placeholder="Nome do usuário..."
            className="w-full border rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Ação</label>
          <select 
            name="action"
            defaultValue={searchParams.action}
            className="w-full border rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-white"
          >
            <option value="">Todas as ações</option>
            <option value="CREATE">CREATE (Criação)</option>
            <option value="UPDATE">UPDATE (Edição)</option>
            <option value="DELETE">DELETE (Exclusão)</option>
            <option value="LOGIN">LOGIN</option>
          </select>
        </div>

        <div className="md:col-span-1">
          <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Período (Início)</label>
          <input 
            name="start"
            type="datetime-local"
            defaultValue={searchParams.start}
            className="w-full border rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Período (Fim)</label>
            <input 
              name="end"
              type="datetime-local"
              defaultValue={searchParams.end}
              className="w-full border rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <button type="submit" className="bg-blue-600 text-white p-2.5 rounded-lg hover:bg-blue-700 transition-colors">
            <Search size={18} />
          </button>
        </div>
      </form>

      <div className="bg-white border rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b text-gray-600 text-sm uppercase tracking-wider">
            <tr>
              <th className="px-6 py-4 font-semibold">Data/Hora</th>
              <th className="px-6 py-4 font-semibold">Usuário</th>
              <th className="px-6 py-4 font-semibold">Ação/Entidade</th>
              <th className="px-6 py-4 font-semibold">Detalhes</th>
            </tr>
          </thead>
          <tbody className="divide-y text-sm">
            {logs.map((log) => (
              <tr key={log.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-6 py-4 text-gray-500 whitespace-nowrap">
                  {format(new Date(log.createdAt), "dd/MM/yyyy HH:mm:ss", { locale: ptBR })}
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full bg-blue-50 flex items-center justify-center text-blue-600">
                      <UserIcon size={14} />
                    </div>
                    <div>
                      <div className="font-medium text-gray-900">{log.user.name}</div>
                      <div className="text-[10px] text-gray-400">{log.user.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="flex flex-col gap-1">
                    <span className={cnActionBadge(log.action)}>
                      {log.action}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] font-bold text-gray-400">
                      <Tag size={10} /> {log.entity}
                    </span>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-start gap-2 max-w-xs md:max-w-md">
                    <Info size={14} className="text-gray-300 mt-0.5 flex-shrink-0" />
                    <span className="text-gray-600 line-clamp-2 italic">
                      {log.details || "Nenhum detalhe adicional."}
                    </span>
                  </div>
                      {/* O Modal entra aqui! */}
                    <AuditDetailModal 
                        action={log.action} 
                        oldData={log.oldData} 
                        newData={log.newData} 
                    />
                </td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colSpan={4} className="px-6 py-12 text-center text-gray-400">
                  Nenhuma atividade registrada ainda.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Função auxiliar para cores dos badges
function cnActionBadge(action: string) {
  const base = "px-2 py-0.5 rounded text-[10px] font-bold w-fit";
  switch (action) {
    case "CREATE": return `${base} bg-green-100 text-green-700`;
    case "UPDATE": return `${base} bg-blue-100 text-blue-700`;
    case "DELETE": return `${base} bg-red-100 text-red-700`;
    default: return `${base} bg-gray-100 text-gray-700`;
  }
}