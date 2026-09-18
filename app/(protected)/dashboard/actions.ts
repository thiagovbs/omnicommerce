"use server";

import { currentActor } from "@/lib/current-actor";
import { prisma } from "@/lib/prisma";
import type { DashboardStats } from "./types";

// The organization comes from the session, never from an argument supplied by the caller.
export async function getDashboardStats(): Promise<DashboardStats> {
  const { organizationId } = await currentActor();

  const [totals, salesByMarketplace] = await Promise.all([
    prisma.sale.aggregate({
      where: { organizationId },
      _sum: { gross: true, net: true },
      _count: { id: true },
    }),
    prisma.sale.groupBy({
      by: ["marketplaceId"],
      where: { organizationId },
      _sum: { net: true },
      _count: { id: true },
    }),
  ]);

  const marketplaces = await prisma.marketplace.findMany({
    where: { organizationId, id: { in: salesByMarketplace.map((sale) => sale.marketplaceId) } },
    select: { id: true, name: true },
  });

  return {
    totalGross: Number(totals._sum.gross ?? 0),
    totalNet: Number(totals._sum.net ?? 0),
    totalOrders: totals._count.id,
    marketplaceStats: salesByMarketplace.map((item) => ({
      name: marketplaces.find((marketplace) => marketplace.id === item.marketplaceId)?.name ?? "Desconhecido",
      value: Number(item._sum.net ?? 0),
      count: item._count.id,
    })),
  };
}
