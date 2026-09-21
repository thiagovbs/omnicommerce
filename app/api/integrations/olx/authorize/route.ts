import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { currentActor } from "@/lib/current-actor";
import { providerDoCanal } from "@/lib/domain/marketplace-provider";
import { isOrgAdmin } from "@/lib/domain/roles";
import { olxAuthorizationUrl } from "@/lib/integrations/olx/oauth";
import { criarEstado, STATE_COOKIE } from "@/lib/integrations/oauth-state";
import { marketplaceSettings } from "@/lib/services/marketplaces";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * Inicia a autorização da OLX.
 *
 * Aqui o nonce vai em `state`, e não no caminho como na Shopee: a OLX cadastra
 * as URIs de redirecionamento uma a uma, por e-mail com o suporte ao
 * integrador, e valida a URI inteira -- um caminho variável não casaria com
 * nenhuma delas.
 */
export async function GET(request: Request) {
  let actor;
  try {
    actor = await currentActor();
  } catch {
    redirect("/login");
  }
  if (!isOrgAdmin(actor.role)) redirect("/dashboard");

  const params = new URL(request.url).searchParams;
  const marketplaceId = params.get("marketplaceId") ?? "";
  const marketplace = marketplaceId
    ? await prisma.marketplace.findFirst({
        where: { id: marketplaceId, organizationId: actor.organizationId, active: true },
        select: { id: true, code: true },
      })
    : null;
  if (!marketplace || providerDoCanal(marketplace.code) !== "OLX") {
    redirect("/integrations?erro=marketplace");
  }

  const connectionId = params.get("connectionId") ?? "";
  const conexao = connectionId
    ? await prisma.marketplaceConnection.findFirst({
        where: {
          id: connectionId, marketplaceId: marketplace.id, provider: "OLX",
          marketplace: { organizationId: actor.organizationId },
        },
        select: { externalAccountId: true },
      })
    : null;
  if (connectionId && !conexao) redirect("/integrations?erro=conexao");

  const { nonce, cookie } = criarEstado(
    actor.organizationId, marketplace.id, conexao?.externalAccountId);
  (await cookies()).set(STATE_COOKIE, cookie, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/integrations/olx",
    maxAge: 600,
  });
  // Credenciais da aplicação: do canal, não do ambiente. Duas organizações
  // no mesmo deploy autorizam cada uma com a aplicação dela.
  const cfg = await marketplaceSettings(prisma, marketplace.id);
  redirect(olxAuthorizationUrl(cfg, nonce));
}
