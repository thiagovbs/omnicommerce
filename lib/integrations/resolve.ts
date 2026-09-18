import "server-only";
import { OrderError } from "../domain/order-input";
import { OrderSnapshotResolver } from "../services/integration-events";
import { decryptSecret } from "./crypto";
import { fetchOrder } from "./mercadolivre/client";
import { normalizeMercadoLivreOrder } from "./mercadolivre/normalize";

// Consulta o pedido no provedor e devolve o snapshot; quem chama valida com
// parseIntegratedOrder, fora de qualquer transação.
export function providerResolver(fetcher: typeof fetch = fetch): OrderSnapshotResolver {
  return async (event) => {
    const { connection } = event;
    if (!connection) throw new OrderError("Evento sem conexão autorizada.");
    if (connection.status !== "ACTIVE") throw new OrderError("Conexão inativa. Reautorize para retomar.");
    if (!connection.accessToken) throw new OrderError("Conexão sem credencial armazenada.");
    // Renovação de token entra junto com o fluxo OAuth; até lá, expirada é falha explícita.
    if (connection.expiresAt && connection.expiresAt <= new Date()) {
      throw new OrderError("Credencial expirada. Reautorize a conexão.");
    }
    switch (connection.provider) {
      case "MERCADO_LIVRE":
        return normalizeMercadoLivreOrder(
          await fetchOrder(decryptSecret(connection.accessToken), event.externalOrderId, fetcher),
        );
      case "SHOPEE":
        throw new OrderError("Integração de pedidos da Shopee não implementada.");
    }
  };
}
