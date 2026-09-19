import "server-only";
import { OrderError } from "../domain/order-input";
import { ListarAlterados } from "../services/reconciliation";
import { decryptSecret } from "./crypto";
import { listChangedSeboOrders } from "./sebo/client";

// Pergunta ao provedor o que mudou. Só a listagem é específica de provedor:
// o pedido em si é buscado depois pelo mesmo resolver dos avisos.
export function providerLister(fetcher: typeof fetch = fetch): ListarAlterados {
  return async (connection, desde) => {
    if (!connection.accessToken) throw new OrderError("Conexão sem credencial armazenada.");
    switch (connection.provider) {
      case "SEBO_ONLINE":
        return listChangedSeboOrders(decryptSecret(connection.accessToken), desde, fetcher);
      case "MERCADO_LIVRE":
        // Os parâmetros de busca por data do ML não foram confirmados na
        // documentação (403) e a conta não tem pedidos para exercitar. Falha
        // nomeada é melhor que código especulativo.
        throw new OrderError("Conciliação do Mercado Livre ainda não implementada.");
      case "SHOPEE":
        throw new OrderError("Conciliação da Shopee ainda não implementada.");
    }
  };
}
