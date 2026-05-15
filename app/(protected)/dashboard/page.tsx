import { prisma } from "@/lib/prisma";
import { getDashboardStats } from "./actions";
import { DollarSign, ShoppingCart, TrendingUp, Store } from "lucide-react";
import { DashboardCharts } from "./charts"; 
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();
  
  // 1. Extraímos o ID da organização da sessão
  const organizationId = (session?.user as any)?.organizationId;

  // 2. Proteção: Se não houver ID, redirecionamos para o login
  if (!organizationId) {
    redirect("/login");
  }

  // 3. Buscamos os dados da organização e as estatísticas em paralelo
  // CORREÇÃO: Definindo a variável 'org' que faltava
  const [org, stats] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: organizationId }
    }),
    getDashboardStats(organizationId) // CORREÇÃO: Usando organizationId em vez de org.id
  ]);

  if (!org) {
    return <div className="p-8 text-center text-red-500 font-semibold">Organização não encontrada.</div>;
  }

  const cards = [
    {
      title: "Faturamento Bruto",
      value: stats.totalGross,
      icon: <DollarSign className="text-blue-600" />,
      description: "Soma total dos produtos vendidos",
    },
    {
      title: "Lucro Líquido",
      value: stats.totalNet,
      icon: <TrendingUp className="text-green-600" />,
      description: "Valor real após taxas e fretes",
    },
    {
      title: "Total de Pedidos",
      value: stats.totalOrders,
      icon: <ShoppingCart className="text-purple-600" />,
      isCurrency: false,
      description: "Volume total de vendas processadas",
    },
  ];

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Dashboard</h1>
        <p className="text-gray-500">
          {/* CORREÇÃO: Agora 'org' está definida e o acesso ao nome funcionará */}
          Análise de desempenho da <span className="font-semibold text-gray-700">{org.name}</span>.
        </p>
      </div>

      {/* Grid de KPIs - Cards de Resumo */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {cards.map((card, i) => (
          <div key={i} className="bg-white p-6 rounded-xl border shadow-sm hover:shadow-md transition-shadow space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium text-gray-500">{card.title}</span>
              {card.icon}
            </div>
            <div className="text-2xl font-bold text-gray-900">
              {card.isCurrency !== false 
                ? card.value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
                : card.value}
            </div>
            <p className="text-xs text-gray-400">{card.description}</p>
          </div>
        ))}
      </div>

      <DashboardCharts stats={stats} />

      <div className="bg-white border rounded-xl shadow-sm p-6">
        <div className="flex items-center gap-2 mb-6">
          <Store className="text-gray-400" size={20} />
          <h2 className="text-lg font-semibold">Ranking por Marketplace</h2>
        </div>
        
        <div className="space-y-4">
          {stats.marketplaceStats.map((item: any, i: number) => (
            <div key={i} className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="font-medium text-gray-700">{item.name}</span>
                <span className="text-gray-500">
                  {item.count} {item.count === 1 ? 'pedido' : 'pedidos'} • 
                  <span className="ml-1 font-semibold text-gray-900">
                    {item.value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                  </span>
                </span>
              </div>
              <div className="w-full bg-gray-100 rounded-full h-2.5 overflow-hidden">
                <div 
                  className="bg-blue-600 h-full rounded-full transition-all duration-500" 
                  style={{ width: `${stats.totalNet > 0 ? (item.value / stats.totalNet) * 100 : 0}%` }}
                />
              </div>
            </div>
          ))}
          {stats.marketplaceStats.length === 0 && (
            <p className="text-center text-gray-400 py-10">Nenhuma venda registrada para gerar estatísticas.</p>
          )}
        </div>
      </div>
    </div>
  );
}