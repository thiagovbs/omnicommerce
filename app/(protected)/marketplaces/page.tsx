import { currentActor } from "@/lib/current-actor";
import { prisma } from "@/lib/prisma";
import { listMarketplaces } from "@/lib/services/marketplaces";
import { MarketplacesClient } from "./marketplaces-client";

export const dynamic = "force-dynamic";

export default async function MarketplacesPage() {
  // currentActor resolve a organização no banco e lança se não houver sessão.
  const actor = await currentActor();

  // O serviço devolve o que está PREENCHIDO, não os valores: nenhuma
  // credencial atravessa a fronteira para o cliente.
  const marketplaces = await listMarketplaces(prisma, actor);

  return <MarketplacesClient initialData={marketplaces} />;
}
