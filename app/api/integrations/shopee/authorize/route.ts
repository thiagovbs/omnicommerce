import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { currentActor } from "@/lib/current-actor";
import { providerDoCanal } from "@/lib/domain/marketplace-provider";
import { isOrgAdmin } from "@/lib/domain/roles";
import { criarEstado, STATE_COOKIE } from "@/lib/integrations/oauth-state";
import { shopeeAuthorizationUrl } from "@/lib/integrations/shopee/oauth";
import { marketplaceSettings } from "@/lib/services/marketplaces";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * Inicia a autorização de uma loja da Shopee.
 *
 * O nonce vai no CAMINHO do callback, não em `state`: a Shopee não tem
 * parâmetro de estado e cola `code` e `shop_id` na URL de redirecionamento.
 * O cookie cifrado continua sendo quem prova organização e canal.
 */
export async function GET(request: Request) {
  // O matcher do proxy exclui /api, então esta rota trata a sessão por conta
  // própria: sem isto, sessão expirada vira 500 em vez de voltar ao login.
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
  if (!marketplace || providerDoCanal(marketplace.code) !== "SHOPEE") {
    redirect("/integrations?erro=marketplace");
  }

  // Reautorização de uma loja específica: com duas lojas no mesmo canal, o
  // provedor devolve a que estiver logada nele, e sem a conta esperada a
  // credencial da outra seria renovada em silêncio.
  const connectionId = params.get("connectionId") ?? "";
  const conexao = connectionId
    ? await prisma.marketplaceConnection.findFirst({
        where: {
          id: connectionId, marketplaceId: marketplace.id, provider: "SHOPEE",
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
    // Lax para o cookie sobreviver ao retorno do provedor, que é navegação
    // GET de topo; Strict o descartaria e o fluxo nunca fecharia.
    sameSite: "lax",
    path: "/api/integrations/shopee",
    maxAge: 600,
  });
  // Credenciais da aplicação: do canal, não do ambiente. Duas organizações
  // no mesmo deploy autorizam cada uma com a aplicação dela.
  const cfg = await marketplaceSettings(prisma, marketplace.id);
  redirect(shopeeAuthorizationUrl(cfg, nonce));
}
