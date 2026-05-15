"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { SaleStatus, Currency } from "@prisma/client";

export async function getSales(organizationId: string) {
  return await prisma.sale.findMany({
    where: { organizationId },
    include: { marketplace: true, items: true },
    orderBy: { soldAt: "desc" },
  });
}

export async function createSale(data: any) {
  const { items, ...saleData } = data;

  // Cálculo do valor líquido (Net) antes de salvar 
  // Net = Gross + Shipping - Discount - Fees
  const gross = Number(saleData.gross);
  const shipping = Number(saleData.shipping || 0);
  const discount = Number(saleData.discount || 0);
  const fees = Number(saleData.fees || 0);
  const net = gross + shipping - discount - fees;

  const newSale = await prisma.sale.create({
    data: {
      ...saleData,
      status: "CREATED",
      soldAt: new Date(saleData.soldAt),
      net: net,
      items: {
        create: items.map((item: any) => ({
          ...item,
          total: Number(item.unitPrice) * Number(item.quantity)
        }))
      }
    }
  });

  // REGISTRO DE AUDITORIA
  await recordAudit({
    action: "CREATE",
    entity: "SALE",
    entityId: newSale.id,
    details: `Venda ${newSale.externalOrderId} criada manualmente.`,
    newData: newSale
  });

  revalidatePath("/sales");
}

export async function updateSaleStatus(saleId: string, newStatus: string) {
  const session = await auth();
  const organizationId = (session?.user as any)?.organizationId;

  // Busca a venda para auditoria
  const oldSale = await prisma.sale.findUnique({
    where: { id: saleId, organizationId }
  });

  if (!oldSale) throw new Error("Venda não encontrada");

  if (oldSale && ["CANCELLED", "REFUNDED","DELIVERED"].includes(oldSale.status)) {
    throw new Error("Vendas entregues, canceladas ou reembolsadas não podem ser editadas.");
  }

  // Atualização com o valor exato do Enum
  const updatedSale = await prisma.sale.update({
    where: { id: saleId },
    data: { 
      status: newStatus as any 
    }
  });

  // Registro detalhado no Log de Auditoria
  await recordAudit({
    action: "UPDATE",
    entity: "SALE",
    entityId: updatedSale.id,
    details: `Status da venda ${updatedSale.externalOrderId} alterado: ${oldSale.status} -> ${newStatus}`,
    oldData: { status: oldSale.status },
    newData: { status: updatedSale.status }
  });

  revalidatePath("/sales");
  revalidatePath("/audit");
  return updatedSale;
}