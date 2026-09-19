import "server-only";
import { Product } from "@prisma/client";
import { objectInput, OrderError } from "../../domain/order-input";
import { ProviderAuthError, ProviderTransientError } from "../mercadolivre/client";
import { seboApiBase } from "./client";

/**
 * Publicação de produto no Sebo On-Line.
 *
 * O contrato é nosso dos dois lados, então ele foi desenhado para ser seguro de
 * repetir: `POST /integration/products` casa pelo `sku` e atualiza em vez de
 * criar um segundo produto. Isso importa porque não existe transação que
 * abranja a chamada ao sebo e a gravação aqui — se a resposta se perder depois
 * de o sebo ter gravado, a retentativa precisa ser inofensiva.
 */

/// O sebo guarda dinheiro em float. Mandamos o número já com duas casas, que é
/// a precisão do nosso Decimal, em vez de deixar a serialização decidir.
function paraNumero(valor: string) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) throw new OrderError("Preço inválido para publicação.");
  return Number(numero.toFixed(2));
}

export function seboProductPayload(product: Product) {
  return {
    sku: product.sku,
    name: product.title,
    description: product.description,
    category: product.category,
    price: paraNumero(product.price.toFixed(2)),
    stock: product.stock,
    image_url: product.imageUrl,
    brand: product.brand,
    condition: product.condition,
    active: product.active,
  };
}

export async function publishSeboProduct(
  token: string, product: Product, fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(`${seboApiBase()}/integration/products`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(seboProductPayload(product)),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  // Nenhuma mensagem de erro carrega token ou corpo da resposta.
  if (response.status === 401 || response.status === 403) throw new ProviderAuthError("SEBO_UNAUTHORIZED");
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("SEBO_UNAVAILABLE");
  if (!response.ok) throw new OrderError("O Sebo On-Line recusou o produto.");

  const corpo = objectInput(await response.json());
  const id = corpo.id;
  if (typeof id !== "number" && typeof id !== "string") {
    throw new OrderError("Publicação no Sebo On-Line sem identificador.");
  }
  // O que volta é o que o sebo gravou, não o que pedimos: se ele arredondar o
  // preço, é o número dele que registramos como publicado.
  if (typeof corpo.price !== "number" || typeof corpo.stock !== "number") {
    throw new OrderError("Publicação no Sebo On-Line sem preço ou estoque.");
  }
  return {
    externalListingId: String(id),
    price: corpo.price.toFixed(2),
    stock: corpo.stock,
  };
}
