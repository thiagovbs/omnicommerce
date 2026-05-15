import { prisma } from "@/lib/prisma";
import { SaleForm } from "./sale-form";
import { format } from "date-fns";
import { auth } from "@/lib/auth";
import { StatusSelect } from "./status-select";
import { FileDown } from "lucide-react"; //

export const dynamic = "force-dynamic";

export default async function SalesPage() {
  const session = await auth();
  
  // Extrai o ID da organização do usuário logado
  const organizationId = (session?.user as any)?.organizationId;

  if (!organizationId) {
    return <div className="p-8">Acesso negado ou organização não encontrada.</div>;
  }

  // Busca os dados necessários em paralelo para melhor performance
  const [allSales, marketplaces] = await Promise.all([
    prisma.sale.findMany({
      where: { organizationId },
      include: { marketplace: true },
      orderBy: { soldAt: "desc" }
    }),
    prisma.marketplace.findMany({ 
      where: { organizationId, active: true } 
    })
  ]);

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Vendas</h1>
        {/* Container para os botões de ação */}
        <div className="flex gap-3">
          <a 
            href="/api/reports/sales" 
            target="_blank" 
            className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-lg flex items-center gap-2 hover:bg-gray-50 transition-all font-medium shadow-sm"
          >
            <FileDown size={18} /> Exportar PDF
          </a>
          <SaleForm organizationId={organizationId} marketplaces={marketplaces} />
        </div>
      </div>

      <div className="bg-white border rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-6 py-4 text-sm font-semibold">Data</th>
              <th className="px-6 py-4 text-sm font-semibold">Marketplace</th>
              <th className="px-6 py-4 text-sm font-semibold">Pedido</th>
              <th className="px-6 py-4 text-sm font-semibold text-right">Líquido (Net)</th>
              <th className="px-6 py-4 text-sm font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {allSales.length > 0 ? (
              allSales.map((sale) => (
                <tr key={sale.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 text-sm">
                    {format(new Date(sale.soldAt), "dd/MM/yyyy")}
                  </td>
                  <td className="px-6 py-4 text-sm">{sale.marketplace.name}</td>
                  <td className="px-6 py-4 text-sm font-mono">{sale.externalOrderId}</td>
                  <td className="px-6 py-4 text-sm text-right font-bold text-green-700">
                    R$ {Number(sale.net).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </td>
                  <td className="px-6 py-4">
                    <StatusSelect 
                      saleId={sale.id} 
                      currentStatus={sale.status} 
                    />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="px-6 py-10 text-center text-gray-500">
                  Nenhuma venda encontrada para esta organização.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}