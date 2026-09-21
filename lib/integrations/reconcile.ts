import "server-only";
import { PrismaClient } from "@prisma/client";
import { OrderError } from "../domain/order-input";
import { marketplaceSettings } from "../services/marketplaces";
import { ListarAlterados } from "../services/reconciliation";
import { decryptSecret } from "./crypto";
import { listChangedSeboOrders } from "./sebo/client";
import { listChangedShopeeOrders } from "./shopee/client";

// Pergunta ao provedor o que mudou. Só a listagem é específica de provedor:
// o pedido em si é buscado depois pelo mesmo resolver dos avisos.
export function providerLister(
  db: PrismaClient, fetcher: typeof fetch = fetch,
): ListarAlterados {
  return async (connection, desde) => {
    if (!connection.accessToken) throw new OrderError("Conexão sem credencial armazenada.");
    switch (connection.provider) {
      case "SEBO_ONLINE":
        // A config é lida no ramo que a usa: a recusa da OLX, abaixo, não
        // tem por que consultar o banco para dizer que não há pedido.
        return listChangedSeboOrders(
          await marketplaceSettings(db, connection.marketplaceId),
          decryptSecret(connection.accessToken), desde, fetcher);
      case "MERCADO_LIVRE":
        // Os parâmetros de busca por data do ML não foram confirmados na
        // documentação (403) e a conta não tem pedidos para exercitar. Falha
        // nomeada é melhor que código especulativo.
        throw new OrderError("Conciliação do Mercado Livre ainda não implementada.");
      case "SHOPEE":
        return listChangedShopeeOrders(
          await marketplaceSettings(db, connection.marketplaceId),
          { accessToken: decryptSecret(connection.accessToken), shopId: connection.externalAccountId },
          desde, fetcher);
      case "OLX":
        // Não é omissão: a OLX é classificados e não tem pedido nenhum para
        // conciliar. A venda acontece fora da plataforma, no telefone ou no
        // chat. Conciliar aqui seria procurar o que não existe.
        throw new OrderError("A OLX não tem pedidos: é canal só de publicação.");
    }
  };
}
