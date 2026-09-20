import "server-only";
import { Product, ProductImage } from "@prisma/client";
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

/// O produto com o álbum já ordenado. O adapter recebe a lista inteira mesmo
/// usando uma imagem só: quem decide quantas cabem é o provedor, não quem
/// monta o payload.
export type ProductWithImages = Product & { images: ProductImage[] };

export function seboProductPayload(product: ProductWithImages) {
  return {
    sku: product.sku,
    name: product.title,
    description: product.description,
    category: product.category,
    price: paraNumero(product.price.toFixed(2)),
    stock: product.stock,
    // O sebo aceita uma imagem só: vai a principal, que é a posição 0.
    image_url: product.images[0]?.url ?? "",
    brand: product.brand,
    condition: product.condition,
    active: product.active,
  };
}

export async function publishSeboProduct(
  token: string, product: ProductWithImages, fetcher: typeof fetch = fetch,
) {
  // Serializado antes de enviar para o tamanho entrar na mensagem de erro: é a
  // diferença entre "recusado por tamanho" e "recusado, não sei por quê".
  const corpo = JSON.stringify(seboProductPayload(product));
  const response = await fetcher(`${seboApiBase()}/integration/products`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: corpo,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  // Nenhuma mensagem de erro carrega token ou corpo da resposta.
  if (response.status === 401 || response.status === 403) throw new ProviderAuthError("SEBO_UNAUTHORIZED");
  // Corpo grande demais tem causa e solução próprias, e quem recusa costuma
  // ser o gateway, não o sebo. Sem separar, o operador leria "recusou o
  // produto" e iria procurar defeito no cadastro.
  if (response.status === 413) {
    throw new OrderError(
      `A publicação tem ${(corpo.length / 1024 / 1024).toFixed(1)} MB e foi recusada por tamanho. `
      + "Use uma imagem principal menor.");
  }
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("SEBO_UNAVAILABLE");
  if (!response.ok) throw new OrderError("O Sebo On-Line recusou o produto.");

  const resposta = objectInput(await response.json());
  const id = resposta.id;
  if (typeof id !== "number" && typeof id !== "string") {
    throw new OrderError("Publicação no Sebo On-Line sem identificador.");
  }
  // O que volta é o que o sebo gravou, não o que pedimos: se ele arredondar o
  // preço, é o número dele que registramos como publicado.
  if (typeof resposta.price !== "number" || typeof resposta.stock !== "number") {
    throw new OrderError("Publicação no Sebo On-Line sem preço ou estoque.");
  }
  return {
    externalListingId: String(id),
    price: resposta.price.toFixed(2),
    stock: resposta.stock,
  };
}
