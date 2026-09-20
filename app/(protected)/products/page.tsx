import { currentActor } from "@/lib/current-actor";
import { prisma } from "@/lib/prisma";
import { providerDoCanal } from "@/lib/domain/marketplace-provider";
import { listProducts } from "@/lib/services/products";
import { ProductsClient } from "./products-client";
import type { ChannelRow, ProductRow } from "./types";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const actor = await currentActor();

  const [produtos, canais] = await Promise.all([
    listProducts(prisma, actor),
    prisma.marketplace.findMany({
      where: { organizationId: actor.organizationId, active: true },
      orderBy: { name: "asc" },
      select: {
        id: true, name: true, code: true,
        connections: {
          where: { status: "ACTIVE" },
          select: { id: true, externalAccountId: true },
          orderBy: { externalAccountId: "asc" },
        },
      },
    }),
  ]);

  // Decimal e Date viram string aqui, uma vez só: o cliente recebe dado pronto
  // e não precisa saber que existe Prisma do outro lado.
  const linhas: ProductRow[] = produtos.map((p) => ({
    id: p.id, sku: p.sku, title: p.title, description: p.description,
    category: p.category, brand: p.brand, condition: p.condition,
    images: p.images.map((i) => i.url),
    price: p.price.toFixed(2), currency: p.currency, stock: p.stock, active: p.active,
    listings: p.listings.map((l) => ({
      id: l.id, status: l.status, needsSync: l.needsSync,
      externalListingId: l.externalListingId,
      categoryExternalId: l.categoryExternalId,
      conta: l.connection?.externalAccountId ?? null,
      publishedPrice: l.publishedPrice ? l.publishedPrice.toFixed(2) : null,
      publishedStock: l.publishedStock,
      lastPublishedAt: l.lastPublishedAt ? l.lastPublishedAt.toISOString() : null,
      lastError: l.lastError,
      marketplace: l.marketplace,
    })),
  }));

  const canaisPublicaveis: ChannelRow[] = canais.map((c) => {
    const contas = c.connections.map((x) => ({ id: x.id, externalAccountId: x.externalAccountId }));
    if (!providerDoCanal(c.code)) {
      return { id: c.id, name: c.name, code: c.code, publicavel: false, motivo: "Canal sem integração", contas };
    }
    if (!contas.length) {
      return { id: c.id, name: c.name, code: c.code, publicavel: false, motivo: "Canal não conectado", contas };
    }
    return { id: c.id, name: c.name, code: c.code, publicavel: true, motivo: null, contas };
  });

  return <ProductsClient produtos={linhas} canais={canaisPublicaveis} />;
}
