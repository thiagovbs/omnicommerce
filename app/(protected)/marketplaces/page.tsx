import { prisma } from "@/lib/prisma";
import { MarketplacesClient } from "./marketplaces-client";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function MarketplacesPage() {
  const session = await auth();
  
  // 1. Obtemos o ID da organização da sessão
  const organizationId = (session?.user as any)?.organizationId;

  // 2. Proteção: Se não houver organização, redirecionamos
  if (!organizationId) {
    redirect("/login");
  }
  
  // 3. Buscamos os marketplaces usando o organizationId da sessão
  const data = await prisma.marketplace.findMany({
    where: { organizationId: organizationId }, // CORREÇÃO: Usando organizationId
    orderBy: { name: "asc" },
  });

  return (
    <MarketplacesClient 
      // Usamos JSON.parse/stringify para evitar problemas de serialização de tipos Prisma (como Decimal)
      initialData={JSON.parse(JSON.stringify(data))} 
      organizationId={organizationId} // CORREÇÃO: Usando organizationId
    />
  );
}