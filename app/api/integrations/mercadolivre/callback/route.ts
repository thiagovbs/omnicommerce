import { after } from "next/server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { currentActor } from "@/lib/current-actor";
import { OrderError } from "@/lib/domain/order-input";
import { isOrgAdmin } from "@/lib/domain/roles";
import { exchangeCode, oauthConfig } from "@/lib/integrations/mercadolivre/oauth";
import { lerEstado, STATE_COOKIE } from "@/lib/integrations/oauth-state";
import { prisma } from "@/lib/prisma";
import { syncCategoriesIfStale } from "@/lib/services/categories";
import { saveProviderConnection } from "@/lib/services/connections";

export const runtime = "nodejs";
// Folga para a importação das categorias, que roda depois da resposta: a
// árvore do MLB são ~29 MB e 12 mil nós.
export const maxDuration = 90;

export async function GET(request: Request) {
  // O matcher do proxy exclui /api, então estas rotas tratam a sessão por conta
  // própria: sem isto, sessão expirada vira 500 em vez de voltar ao login.
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
  // Estado é de uso único: sai do navegador antes de qualquer decisão.
  jar.delete({ name: STATE_COOKIE, path: "/api/integrations/mercadolivre" });

  // O provedor recusou ou o usuário desistiu.
  if (params.get("error")) redirect("/integrations?erro=autorizacao");

  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  if (!code || !state || !cookie) redirect("/integrations?erro=estado");

  let destino = "/integrations?conectado=1";
  try {
    const estado = lerEstado(cookie, state);
    // A sessão que conclui precisa ser da mesma organização que iniciou.
    if (estado.organizationId !== actor.organizationId) throw new OrderError("Organização divergente.");
    const tokens = await exchangeCode(code);
    await saveProviderConnection(prisma, actor, {
      provider: "MERCADO_LIVRE",
      marketplaceId: estado.marketplaceId,
      externalAccountId: tokens.externalAccountId,
      // O escopo pedido vem da mesma configuração que montou a autorização.
      tokens: { ...tokens, escopoPedido: oauthConfig().scope || null },
    });

    // A árvore de categorias é importada DEPOIS da resposta: são alguns
    // segundos que não têm por que segurar o redirecionamento de quem acabou
    // de autorizar. A conexão já está gravada, então uma falha aqui não desfaz
    // nada — e a importação se recupera sozinha, porque é disparada de novo
    // pelo job e pelo botão da tela enquanto a árvore estiver ausente.
    const marketplaceId = estado.marketplaceId;
    after(async () => {
      await syncCategoriesIfStale(prisma, marketplaceId, "MERCADO_LIVRE", tokens.accessToken);
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
