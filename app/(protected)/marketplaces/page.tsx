import { currentActor } from "@/lib/current-actor";
import { prisma } from "@/lib/prisma";
import { MarketplacesClient } from "./marketplaces-client";

export const dynamic = "force-dynamic";

export default async function MarketplacesPage() {
  // currentActor resolve a organização no banco e lança se não houver sessão.
  const { organizationId } = await currentActor();

  // Apenas campos escalares: dispensa o round-trip por JSON para serializar ao cliente.
  const marketplaces = await prisma.marketplace.findMany({
    where: { organizationId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, code: true, active: true },
  });

  return <MarketplacesClient initialData={marketplaces} />;
}
