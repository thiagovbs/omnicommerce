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

/// Limite do arquivo enviado, igual ao do Sebo On-Line: uma imagem que entra
/// lá precisa entrar aqui, senão a publicação falha depois do cadastro.
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/// Base64 cresce 4 bytes a cada 3, mais o cabeçalho do data URI.
const MAX_DATA_URI = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64;

/// Formatos aceitos no upload. Lista fechada em vez de `image/*`: SVG é um
/// documento, não uma imagem, e ainda que num <img> ele não execute script,
/// nada garante que todo consumidor do catálogo o trate assim.
const TIPOS_DE_IMAGEM = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"];

export function tipoDeImagemAceito(tipo: string) {
  return TIPOS_DE_IMAGEM.includes(tipo.trim().toLowerCase());
}

/// Teto do álbum. O Mercado Livre aceita 12 por anúncio; parar antes disso
/// evita descobrir o limite do provedor só na hora de publicar.
export const MAX_IMAGENS = 10;

/**
 * Uma imagem: URL https ou o arquivo enviado, guardado no banco como data URI
 * em base64.
 *
 * O data URI é validado inteiro — tipo declarado e base64 bem formado — porque
 * o que entra aqui vai para o banco e depois para o provedor. Um valor
 * malformado só apareceria na hora da publicação, longe de quem o digitou.
 */
/// Prefixo de uma imagem que JÁ está no álbum deste produto.
///
/// Existe porque o salvamento não pode carregar o álbum inteiro: cada foto
/// ocupa até 4 MB em base64, o corpo de uma Server Action é limitado (e a
/// Vercel corta em 4,5 MB de qualquer forma), então a partir de um punhado de
/// fotos salvar seria impossível. A imagem viaja UMA VEZ, na requisição que a
/// anexa; depois disso ela é referenciada pelo id da linha.
export const PREFIXO_REF = "ref:";

export function referenciaDeImagem(valor: string) {
  return valor.startsWith(PREFIXO_REF) ? valor.slice(PREFIXO_REF.length) : null;
}

export function imagem(value: unknown) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new OrderError("Imagem inválida.");
  const texto = value.trim();

  // Referência a uma linha que já existe: quem resolve é o serviço, que sabe
  // quais imagens são deste produto.
  const ref = referenciaDeImagem(texto);
  if (ref !== null) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(ref)) throw new OrderError("Imagem inválida.");
    return texto;
  }

  if (texto.startsWith("data:")) {
    if (texto.length > MAX_DATA_URI) {
      throw new OrderError(`A imagem excede o limite de ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`);
    }
    const partes = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(texto);
    if (!partes) throw new OrderError("Imagem enviada em formato inválido.");
    if (!tipoDeImagemAceito(partes[1])) {
      throw new OrderError("Formato de imagem não aceito. Use PNG, JPEG, WEBP, GIF ou AVIF.");
    }
    // Base64 vem em blocos de 4; qualquer outro tamanho é truncamento.
    if (partes[2].length % 4 !== 0) throw new OrderError("Imagem enviada está incompleta.");
    return texto;
  }

  // URL externa: https porque o provedor busca pelo servidor dele, e http
  // seria recusado ou degradado.
  if (texto.length > 500) throw new OrderError("URL da imagem inválida.");
  let url: URL;
  try { url = new URL(texto); } catch { throw new OrderError("URL da imagem inválida."); }
  if (url.protocol !== "https:") throw new OrderError("A URL da imagem precisa ser https.");
  return url.toString();
}

/**
 * O álbum, na ordem em que foi montado.
 *
 * A primeira posição é a principal: é ela que vai para o provedor que aceita
 * uma imagem só. Repetidas são descartadas em vez de recusadas — a mesma foto
 * duas vezes é engano de quem cadastra, não erro que mereça travar o salvamento.
 */
function album(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new OrderError("Álbum de imagens inválido.");
  if (value.length > MAX_IMAGENS) {
    throw new OrderError(`O álbum aceita no máximo ${MAX_IMAGENS} imagens.`);
  }
  const vistas = new Set<string>();
  const imagens: string[] = [];
  for (const item of value) {
    const url = imagem(item);
    // Entrada vazia no meio da lista bagunçaria as posições.
    if (!url || vistas.has(url)) continue;
    vistas.add(url);
    imagens.push(url);
  }
  return imagens;
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
    images: album(value.images),
    price: dinheiro(value.price, "Preço"),
    currency: moeda as Currency,
    stock: inteiroNaoNegativo(value.stock, "Estoque"),
    active: value.active === undefined || value.active === null ? true : value.active === true || value.active === "true",
  };
}

export type ProductInput = ReturnType<typeof parseProduct>;
