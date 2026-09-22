import {
  AlertTriangle, DollarSign, Layers, Package, PackageX, ShoppingCart, Store, TrendingUp,
} from "lucide-react";
import { currentActor } from "@/lib/current-actor";
import { prisma } from "@/lib/prisma";
import { getDashboardStats } from "./actions";
import { DashboardCharts } from "./charts";
import { LowStockTable, ProductCharts } from "./product-charts";
import { getProductStats } from "./product-stats";
import { DashboardTabs } from "./tabs";

export const dynamic = "force-dynamic";

function real(valor: number | string) {
  return Number(valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function Card({ titulo, valor, icone, descricao }: {
  titulo: string; valor: string; icone: React.ReactNode; descricao: string;
}) {
  return (
    <div className="bg-white p-6 rounded-xl border shadow-sm hover:shadow-md transition-shadow space-y-2">
      <div className="flex justify-between items-center">
        <span className="text-sm font-medium text-gray-500">{titulo}</span>
        {icone}
      </div>
      <div className="text-2xl font-bold text-gray-900">{valor}</div>
      <p className="text-xs text-gray-400">{descricao}</p>
    </div>
  );
}

export default async function DashboardPage() {
  // currentActor resolves the organization from the database and throws when unauthenticated.
  const { organizationId } = await currentActor();

  const [org, stats, produtos] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
    getDashboardStats(),
    getProductStats(prisma, organizationId),
  ]);

  if (!org) {
    return <div className="p-8 text-center text-red-500 font-semibold">Organização não encontrada.</div>;
  }

  const vendas = (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card
          titulo="Faturamento Bruto" valor={real(stats.totalGross)}
          icone={<DollarSign className="text-blue-600" />}
          descricao="Soma total dos produtos vendidos"
        />
        <Card
          titulo="Lucro Líquido" valor={real(stats.totalNet)}
          icone={<TrendingUp className="text-green-600" />}
          descricao="Valor real após taxas e fretes"
        />
        <Card
          titulo="Total de Pedidos" valor={String(stats.totalOrders)}
          icone={<ShoppingCart className="text-purple-600" />}
          descricao="Volume total de vendas processadas"
        />
      </div>

      <DashboardCharts stats={stats} />

      <div className="bg-white border rounded-xl shadow-sm p-6">
        <div className="flex items-center gap-2 mb-6">
          <Store className="text-gray-400" size={20} />
          <h2 className="text-lg font-semibold">Ranking por Marketplace</h2>
        </div>
        <div className="space-y-4">
          {stats.marketplaceStats.map((item, i) => (
            <div key={i} className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="font-medium text-gray-700">{item.name}</span>
                <span className="text-gray-500">
                  {item.count} {item.count === 1 ? "pedido" : "pedidos"} •
                  <span className="ml-1 font-semibold text-gray-900">{real(item.value)}</span>
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
    </>
  );

  const catalogo = (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
        <Card
          titulo="Produtos no catálogo" valor={String(produtos.total)}
          icone={<Package className="text-blue-600" />}
          descricao={`${produtos.ativos} ativo(s)`}
        />
        <Card
          titulo="Unidades em estoque" valor={produtos.unidades.toLocaleString("pt-BR")}
          icone={<Layers className="text-indigo-600" />}
          descricao="Somadas em todos os produtos"
        />
        <Card
          titulo="Valor do estoque" valor={real(produtos.valorEstoque)}
          icone={<DollarSign className="text-green-600" />}
          descricao="Preço de venda × unidades"
        />
        <Card
          titulo="Anúncios publicados" valor={String(produtos.anunciosPublicados)}
          icone={produtos.anunciosComFalha
            ? <AlertTriangle className="text-amber-600" />
            : <Store className="text-gray-400" />}
          descricao={produtos.anunciosComFalha
            ? `${produtos.anunciosComFalha} anúncio(s) com falha`
            : "Nenhuma falha de publicação"}
        />
      </div>

      {produtos.semEstoque > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <PackageX size={18} className="shrink-0" />
          {produtos.semEstoque} produto(s) sem estoque. Os canais publicados já receberam zero.
        </div>
      )}

      <ProductCharts stats={produtos} />
      <LowStockTable stats={produtos} />
    </>
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Dashboard</h1>
        <p className="text-gray-500">
          Análise de desempenho da <span className="font-semibold text-gray-700">{org.name}</span>.
        </p>
      </div>

      <DashboardTabs vendas={vendas} produtos={catalogo} />
    </div>
  );
}
