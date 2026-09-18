import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { currentActor } from "@/lib/current-actor";
import { isOrgAdmin } from "@/lib/domain/roles";
import { authorizationUrl } from "@/lib/integrations/mercadolivre/oauth";
import { criarEstado, STATE_COOKIE } from "@/lib/integrations/oauth-state";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

// Inicia a autorização. O canal vem por query, mas é conferido dentro da
// organização da sessão — quem escolhe o tenant é a sessão, nunca a URL.
export async function GET(request: Request) {
  const actor = await currentActor();
  if (!isOrgAdmin(actor.role)) redirect("/dashboard");

  const marketplaceId = new URL(request.url).searchParams.get("marketplaceId") ?? "";
  const marketplace = marketplaceId
    ? await prisma.marketplace.findFirst({
        where: { id: marketplaceId, organizationId: actor.organizationId, active: true },
        select: { id: true },
      })
    : null;
  if (!marketplace) redirect("/integrations?erro=marketplace");

  const { nonce, cookie } = criarEstado(actor.organizationId, marketplace.id);
  (await cookies()).set(STATE_COOKIE, cookie, {
    httpOnly: true,
    secure: true,
    // Lax para o cookie sobreviver ao retorno do provedor, que é navegação
    // GET de topo; Strict o descartaria e o fluxo nunca fecharia.
    sameSite: "lax",
    path: "/api/integrations/mercadolivre",
    maxAge: 600,
  });
  redirect(authorizationUrl(nonce));
}
