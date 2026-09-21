import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { currentActor } from "@/lib/current-actor";
import { OrderError } from "@/lib/domain/order-input";
import { isOrgAdmin } from "@/lib/domain/roles";
import { assertContaEsperada, lerEstado, STATE_COOKIE } from "@/lib/integrations/oauth-state";
import { exchangeShopeeCode, lerRetornoDeAutorizacao } from "@/lib/integrations/shopee/oauth";
import { marketplaceSettings } from "@/lib/services/marketplaces";
import { prisma } from "@/lib/prisma";
import { saveProviderConnection } from "@/lib/services/connections";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ nonce: string }> }) {
  let actor;
  try {
    actor = await currentActor();
  } catch {
    redirect("/login");
  }
  if (!isOrgAdmin(actor.role)) redirect("/dashboard");

  const jar = await cookies();
  const cookie = jar.get(STATE_COOKIE)?.value ?? "";
  // Estado é de uso único: sai do navegador antes de qualquer decisão.
  jar.delete({ name: STATE_COOKIE, path: "/api/integrations/shopee" });

  const nonce = decodeURIComponent((await params).nonce ?? "");
  if (!nonce || !cookie) redirect("/integrations?erro=estado");

  let destino = "/integrations?conectado=1";
  try {
    const estado = lerEstado(cookie, nonce);
    // A sessão que conclui precisa ser da mesma organização que iniciou.
    if (estado.organizationId !== actor.organizationId) throw new OrderError("Organização divergente.");

    const { code, shopId } = lerRetornoDeAutorizacao(new URL(request.url).searchParams);
    assertContaEsperada(estado, shopId);
    // A mesma configuração que montou a autorização fecha a troca do código.
    const cfg = await marketplaceSettings(prisma, estado.marketplaceId);
    const tokens = await exchangeShopeeCode(cfg, code, shopId);
    await saveProviderConnection(prisma, actor, {
      provider: "SHOPEE",
      marketplaceId: estado.marketplaceId,
      externalAccountId: tokens.externalAccountId,
      tokens,
    });
  } catch (error) {
    // Motivo de domínio vai para a tela; qualquer outro fica genérico, porque
    // pode carregar detalhe do provedor.
    destino = error instanceof OrderError
      ? `/integrations?erro=${encodeURIComponent(error.message)}`
      : "/integrations?erro=falha";
  }
  redirect(destino);
}
