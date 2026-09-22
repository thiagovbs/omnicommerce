import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { currentActor } from "@/lib/current-actor";
import { OrderError } from "@/lib/domain/order-input";
import { isOrgAdmin } from "@/lib/domain/roles";
import { exchangeFacebookCode, fetchFacebookAccount } from "@/lib/integrations/facebook/oauth";
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
  jar.delete({ name: STATE_COOKIE, path: "/api/integrations/facebook" });

  // Recusa da Meta volta na própria URL (`error`, `error_reason`,
  // `error_description`) e sem código.
  if (params.get("error")) redirect("/integrations?erro=autorizacao");

  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  if (!code || !state || !cookie) redirect("/integrations?erro=estado");

  let destino = "/integrations?conectado=1";
  try {
    const estado = lerEstado(cookie, state);
    if (estado.organizationId !== actor.organizationId) throw new OrderError("Organização divergente.");

    // A mesma configuração que montou a autorização fecha a troca do código.
    const cfg = await marketplaceSettings(prisma, estado.marketplaceId);
    // Já devolve o token de longa duração: o curto vale cerca de uma hora e
    // não pode ser trocado depois de vencer.
    const tokens = await exchangeFacebookCode(cfg, code);
    // Identifica quem autorizou (a conexão é única por provedor e conta) e
    // confere, aqui, se o escopo do catálogo foi mesmo concedido.
    const conta = await fetchFacebookAccount(cfg, tokens);
    assertContaEsperada(estado, conta.externalAccountId);
    await saveProviderConnection(prisma, actor, {
      provider: "FACEBOOK",
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
