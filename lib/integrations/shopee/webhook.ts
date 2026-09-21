import "server-only";
import { PrismaClient } from "@prisma/client";
import { assinaturaDePushValida } from "./client";
import { configDoAviso, handleProviderNotification } from "../webhook";
import { parseShopeeNotification } from "./notification";

/**
 * Recepção do push da Shopee.
 *
 * A autenticação principal é a mesma dos outros provedores: o segredo no
 * caminho da URL, que só quem cadastrou a URL no console conhece.
 *
 * A Shopee TAMBÉM assina o push (HMAC-SHA256 do endereço concatenado ao corpo
 * cru, no header `Authorization`), e conferir isso é defesa em profundidade.
 * Só que a construção dessa assinatura não foi medida — e um palpite errado
 * aqui derrubaria TODO aviso com 404, com o sintoma de "nenhum pedido chegou",
 * que é o defeito mais caro que já tivemos (a URL truncada em 120 caracteres no
 * DevCenter do Mercado Livre custou um dia). Então a conferência é opcional e
 * nasce desligada: ligue "Conferir assinatura do push" na tela de Marketplaces
 * depois de ver aviso chegando.
 */
export async function handleShopeeNotification(db: PrismaClient, request: Request, secret: string) {
  const canal = await configDoAviso(db, "SHOPEE", secret);
  if (!canal) return new Response("Not found", { status: 404 });

  return handleProviderNotification(db, request, secret, {
    provider: "SHOPEE",
    secret: canal.cfg.webhookSecret,
    assinatura: canal.cfg.verifyPush === "true"
      ? (corpoCru, req) => {
        const assinatura = req.headers.get("authorization") ?? "";
        // O endereço que entra no cálculo é o que a Shopee chamou, sem query.
        const url = new URL(req.url);
        return assinaturaDePushValida(canal.cfg, url.origin + url.pathname, corpoCru, assinatura);
      }
      : undefined,
    parse: (body) => {
      const aviso = parseShopeeNotification(body);
      if (!aviso) return null;
      return {
        orderId: aviso.orderSn,
        externalAccountId: aviso.shopId,
        externalEventId: aviso.externalEventId,
      };
    },
  });
}
