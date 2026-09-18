"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { currentActor } from "@/lib/current-actor";
import { OrderError } from "@/lib/domain/order-input";
import { prisma } from "@/lib/prisma";
import { createManualOrder, changeManualStatus } from "@/lib/services/sales";

function failure(error: unknown) {
  if (error instanceof OrderError) return { ok: false as const, error: error.message };
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return { ok: false as const, error: "Já existe um pedido com esse identificador no marketplace." };
  }
  return { ok: false as const, error: "Não foi possível salvar. Tente novamente." };
}

function refreshSales() {
  for (const path of ["/sales", "/dashboard", "/audit"]) revalidatePath(path);
}

export async function getSales() {
  const actor = await currentActor();
  const sales = await prisma.sale.findMany({ where: { organizationId: actor.organizationId }, include: { marketplace: true, items: true }, orderBy: { soldAt: "desc" } });
  return sales.map((sale) => ({ ...sale,
    gross: sale.gross.toFixed(2), shipping: sale.shipping.toFixed(2), discount: sale.discount.toFixed(2), fees: sale.fees.toFixed(2), net: sale.net.toFixed(2),
    items: sale.items.map((item) => ({ ...item, unitPrice: item.unitPrice.toFixed(2), total: item.total.toFixed(2) })),
  }));
}

export async function createSale(data: unknown) {
  try {
    const sale = await createManualOrder(prisma, await currentActor(), data);
    refreshSales();
    return { ok: true as const, sale };
  } catch (error) { return failure(error); }
}

export async function updateSaleStatus(saleId: string, newStatus: string, expectedVersion: number) {
  try {
    const sale = await changeManualStatus(prisma, await currentActor(), saleId, newStatus, expectedVersion);
    refreshSales();
    return { ok: true as const, sale };
  } catch (error) { return failure(error); }
}
