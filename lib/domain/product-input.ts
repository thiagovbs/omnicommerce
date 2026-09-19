import { Currency, Prisma } from "@prisma/client";
import { objectInput, OrderError, textInput } from "./order-input";

/**
 * Validação do produto do catálogo.
 *
 * O catálogo é a fonte da verdade que vai para os canais, então o que entra
 * aqui precisa satisfazer o provedor mais exigente. Recusar cedo é mais barato
 * que descobrir no meio da publicação, quando o anúncio já foi criado pela
 * metade no provedor e não há transação que desfaça.
 */

/// Limite do Mercado Livre para título de anúncio. O sebo não tem limite, mas
/// um só catálogo serve os dois, e é o menor que manda.
const TITULO_MAX = 60;
const MOEDAS: Currency[] = ["BRL", "USD", "EUR"];

function texto(value: unknown, label: string, max: number, obrigatorio: boolean) {
  if (value === undefined || value === null || value === "") {
    if (obrigatorio) throw new OrderError(`${label} é obrigatório.`);
    return "";
  }
  return textInput(value, label, max);
}

function dinheiro(value: unknown, label: string) {
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^\d{1,12}(\.\d{1,2})?$/.test(String(value))) {
    throw new OrderError(`${label} deve ser um valor positivo com até duas casas decimais.`);
  }
  const decimal = new Prisma.Decimal(String(value));
  if (decimal.lessThanOrEqualTo(0)) throw new OrderError(`${label} deve ser maior que zero.`);
  if (decimal.greaterThan("999999999999.99")) throw new OrderError(`${label} excede o limite.`);
  return decimal;
}

export function inteiroNaoNegativo(value: unknown, label: string) {
  const numero = typeof value === "string" && /^\d{1,9}$/.test(value.trim())
    ? Number(value.trim()) : value;
  if (typeof numero !== "number" || !Number.isInteger(numero) || numero < 0 || numero > 999999999) {
    throw new OrderError(`${label} deve ser um número inteiro não negativo.`);
  }
  return numero;
}

/// SKU é a chave que liga um item vendido de volta ao catálogo, e viaja por
/// URL e por sistemas de terceiros: caractere exótico aqui vira defeito lá.
function sku(value: unknown) {
  const texto = textInput(value, "SKU", 60);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(texto)) {
    throw new OrderError("SKU aceita apenas letras, números, ponto, hífen e sublinhado.");
  }
  return texto.toUpperCase();
}

/// A imagem é opcional no catálogo, mas quando existe precisa ser https: o
/// provedor busca a URL pelo servidor dele, e http seria recusado ou degradado.
function imagem(value: unknown) {
  if (value === undefined || value === null || value === "") return "";
  const texto = textInput(value, "URL da imagem", 500);
  let url: URL;
  try { url = new URL(texto); } catch { throw new OrderError("URL da imagem inválida."); }
  if (url.protocol !== "https:") throw new OrderError("A URL da imagem precisa ser https.");
  return url.toString();
}

export function parseProduct(input: unknown) {
  const value = objectInput(input);
  const moeda = value.currency === undefined || value.currency === null || value.currency === ""
    ? "BRL" : textInput(value.currency, "Moeda", 3).toUpperCase();
  if (!MOEDAS.includes(moeda as Currency)) throw new OrderError("Moeda inválida.");

  return {
    sku: sku(value.sku),
    title: texto(value.title, "Título", TITULO_MAX, true),
    description: texto(value.description, "Descrição", 5000, false),
    category: texto(value.category, "Categoria", 100, false),
    brand: texto(value.brand, "Marca", 100, false),
    condition: texto(value.condition, "Condição", 60, false),
    imageUrl: imagem(value.imageUrl),
    price: dinheiro(value.price, "Preço"),
    currency: moeda as Currency,
    stock: inteiroNaoNegativo(value.stock, "Estoque"),
    active: value.active === undefined || value.active === null ? true : value.active === true || value.active === "true",
  };
}

export type ProductInput = ReturnType<typeof parseProduct>;
