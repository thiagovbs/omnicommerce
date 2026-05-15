"use server";

import { prisma } from "@/lib/prisma";

export async function getDashboardStats(organizationId: string) {
  const [totals, salesByMarketplace] = await Promise.all([
    // Agregação de valores totais
    prisma.sale.aggregate({
      where: { organizationId },
      _sum: {
        gross: true,
        net: true,
      },
      _count: {
        id: true,
      },
    }),
    // Agrupamento por Marketplace
    prisma.sale.groupBy({
      by: ['marketplaceId'],
      where: { organizationId },
      _sum: {
        net: true,
      },
      _count: {
        id: true,
      },
    }),
  ]);

  // Busca os nomes dos marketplaces para o gráfico
  const marketplaces = await prisma.marketplace.findMany({
    where: { id: { in: salesByMarketplace.map(s => s.marketplaceId) } }
  });

  const formattedMarketplaceData = salesByMarketplace.map(item => ({
    name: marketplaces.find(m => m.id === item.marketplaceId)?.name || "Desconhecido",
    value: Number(item._sum.net || 0),
    count: item._count.id
  }));

  return {
    totalGross: Number(totals._sum.gross || 0),
    totalNet: Number(totals._sum.net || 0),
    totalOrders: totals._count.id,
    marketplaceStats: formattedMarketplaceData,
  };
}