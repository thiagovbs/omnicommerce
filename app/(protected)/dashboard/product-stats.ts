import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";
import type { ProductStats } from "./types";

/**
 * Números do catálogo para o painel.
 *
 * Todo dinheiro é somado em Decimal e só vira string na saída. Converter para
 * Number no meio perderia centavos em catálogos grandes — é o mesmo cuidado do
 * caminho de pedidos, que a agregação de vendas ainda não tem.
 */

/// Janela do gráfico de estoque. Trinta dias cabem na largura da tela sem
/// virar uma mancha e cobrem o ciclo de reposição típico.
export const DIAS_DO_GRAFICO = 30;

function diaISO(data: Date) {
  return data.toISOString().slice(0, 10);
}

export async function getProductStats(
  db: PrismaClient, organizationId: string, agora = new Date(),
): Promise<ProductStats> {
  const desde = new Date(agora);
  desde.setUTCDate(desde.getUTCDate() - (DIAS_DO_GRAFICO - 1));
  desde.setUTCHours(0, 0, 0, 0);

  const [produtos, anuncios, movimentos, vendidos] = await Promise.all([
    db.product.findMany({
      where: { organizationId },
      select: { id: true, sku: true, title: true, price: true, stock: true, active: true },
    }),
    db.listing.groupBy({
      by: ["status"],
      where: { product: { organizationId } },
      _count: { _all: true },
    }),
    db.stockMovement.findMany({
      where: { organizationId, createdAt: { gte: desde } },
      select: { createdAt: true, delta: true },
      orderBy: { createdAt: "asc" },
    }),
    // Cancelada não é venda: contar no ranking inflaria o que mais sai.
    db.saleItem.groupBy({
      by: ["title"],
      where: { sale: { organizationId, status: { not: "CANCELLED" } } },
      _sum: { quantity: true, total: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 8,
    }),
  ]);

  const unidades = produtos.reduce((soma, p) => soma + p.stock, 0);
  const valor = produtos.reduce(
    (soma, p) => soma.add(p.price.mul(p.stock)), new Prisma.Decimal(0));

  // O saldo de um dia é o saldo de hoje menos tudo que se moveu depois dele.
  // Só funciona porque todo caminho que mexe em estoque grava um movimento.
  const deltaPorDia = new Map<string, number>();
  for (const m of movimentos) {
    const dia = diaISO(m.createdAt);
    deltaPorDia.set(dia, (deltaPorDia.get(dia) ?? 0) + m.delta);
  }

  const estoquePorDia: { dia: string; unidades: number }[] = [];
  let saldo = unidades;
  for (let i = 0; i < DIAS_DO_GRAFICO; i++) {
    const data = new Date(agora);
    data.setUTCDate(data.getUTCDate() - i);
    const dia = diaISO(data);
    estoquePorDia.push({ dia, unidades: saldo });
    saldo -= deltaPorDia.get(dia) ?? 0;
  }
  estoquePorDia.reverse();

  const porSku = new Map(produtos.map((p) => [p.title, p.sku]));
  const publicados = anuncios.find((a) => a.status === "PUBLISHED")?._count._all ?? 0;
  const comFalha = anuncios.find((a) => a.status === "FAILED")?._count._all ?? 0;

  return {
    total: produtos.length,
    ativos: produtos.filter((p) => p.active).length,
    semEstoque: produtos.filter((p) => p.stock === 0).length,
    unidades,
    valorEstoque: valor.toFixed(2),
    anunciosPublicados: publicados,
    anunciosComFalha: comFalha,
    estoquePorDia,
    maisVendidos: vendidos.map((item) => ({
      titulo: item.title,
      sku: porSku.get(item.title) ?? null,
      unidades: item._sum.quantity ?? 0,
      receita: (item._sum.total ?? new Prisma.Decimal(0)).toFixed(2),
    })),
    // Quem tem menos primeiro: é a lista de quem pode faltar.
    estoqueBaixo: produtos
      .filter((p) => p.active)
      .sort((a, b) => a.stock - b.stock)
      .slice(0, 8)
      .map((p) => ({ sku: p.sku, titulo: p.title, estoque: p.stock, preco: p.price.toFixed(2) })),
  };
}
