import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { currentActor } from "@/lib/current-actor";
import { OrderError } from "@/lib/domain/order-input";
import { isOrgAdmin } from "@/lib/domain/roles";
import { exchangeOlxCode, fetchOlxUserInfo } from "@/lib/integrations/olx/oauth";
import { assertContaEsperada, lerEstado, STATE_COOKIE } from "@/lib/integrations/oauth-state";
import { marketplaceSettings } from "@/lib/services/marketplaces";
import { prisma } from "@/lib/prisma";
import { saveProviderConnection } from "@/lib/services/connections";

export const runtime = "nodejs";

export async function GET(request: Request) {
  let actor;
  try {
    actor = await currentActor();
  } catch {
    redirect("/login");
  }
  if (!isOrgAdmin(actor.role)) redirect("/dashboard");

  const params = new URL(request.url).searchParams;
  const jar = await cookies();
  const cookie = jar.get(STATE_COOKIE)?.value ?? "";
  jar.delete({ name: STATE_COOKIE, path: "/api/integrations/olx" });

  if (params.get("error")) redirect("/integrations?erro=autorizacao");

  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  // `state` não está documentado na OLX. Mandamos e exigimos de volta, porque é
  // ele que liga este retorno ao cookie desta sessão; sem ele não há como
  // atribuir a autorização a uma organização com segurança.
  if (!code || !state || !cookie) redirect("/integrations?erro=estado");

  let destino = "/integrations?conectado=1";
  try {
    const estado = lerEstado(cookie, state);
    if (estado.organizationId !== actor.organizationId) throw new OrderError("Organização divergente.");

    // A mesma configuração que montou a autorização fecha a troca do código.
    const cfg = await marketplaceSettings(prisma, estado.marketplaceId);
    const tokens = await exchangeOlxCode(cfg, code);
    // A OLX não devolve identificador de conta no token, e sem ele não há como
    // saber se esta autorização é a mesma conta de antes ou outra -- a conexão
    // é única por (provedor, conta).
    const conta = await fetchOlxUserInfo(cfg, tokens.accessToken);
    assertContaEsperada(estado, conta.externalAccountId);
    await saveProviderConnection(prisma, actor, {
      provider: "OLX",
      marketplaceId: estado.marketplaceId,
      externalAccountId: conta.externalAccountId,
      tokens,
    });
  } catch (error) {
    destino = error instanceof OrderError
      ? `/integrations?erro=${encodeURIComponent(error.message)}`
      : "/integrations?erro=falha";
  }
  redirect(destino);
}
