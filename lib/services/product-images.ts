import "server-only";
import { PrismaClient } from "@prisma/client";

/**
 * A imagem de um produto servida por endereço público.
 *
 * O álbum guarda `https://...` quando alguém cadastra por URL e um **data URI
 * em base64** quando o arquivo é enviado do computador. Guardar o arquivo
 * resolveu o cadastro e criou outro problema: canal de anúncio **busca a
 * imagem no endereço**. A Meta, a OLX e a Shopee não aceitam arquivo embutido
 * -- e os produtos deste catálogo estão todos em base64, então nenhum deles
 * publicaria.
 *
 * Esta rota dá endereço ao que já existe, sem migrar dado nem contratar
 * armazenamento: o que está no banco continua no banco, e o canal recebe uma
 * URL que responde a imagem.
 *
 * Duas restrições que não são detalhe:
 *
 * - **Só tipo de imagem conhecido.** Servir o que o banco disser deixaria a
 *   loja publicar `text/html` (ou SVG, que carrega script) no NOSSO domínio --
 *   é XSS armazenado com endereço próprio. A lista é de formatos rasterizados,
 *   que é o que os canais aceitam de qualquer forma.
 * - **`nosniff`**, para o navegador não adivinhar tipo diferente do declarado.
 */

/// Formatos que os canais aceitam e que não executam nada ao serem abertos.
/// SVG fica de fora de propósito: ele é documento, não imagem.
const TIPOS = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export interface ImagemServida {
  /// Redirecionar para o endereço que já é público, em vez de copiar bytes.
  redirecionar?: string;
  bytes?: Buffer;
  tipo?: string;
}

/// Lê a imagem do álbum e diz como servi-la. `null` é 404: id inexistente,
/// endereço que não é imagem ou formato que não servimos.
export async function imagemDoProduto(
  db: PrismaClient, id: string,
): Promise<ImagemServida | null> {
  // O id é um cuid, não um sequencial: não há vizinho a adivinhar. A forma é
  // conferida de leve -- letras, números, hífen e sublinhado --, o suficiente
  // para nem consultar o banco com lixo, sem casar com o comprimento exato do
  // gerador: trocar de cuid para uuid um dia não pode fazer toda imagem
  // responder 404.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const imagem = await db.productImage.findUnique({ where: { id }, select: { url: true } });
  if (!imagem) return null;

  if (/^https?:\/\//i.test(imagem.url)) return { redirecionar: imagem.url };

  const partes = /^data:([a-z0-9.+/-]+);base64,([a-z0-9+/=\s]+)$/i.exec(imagem.url);
  if (!partes) return null;
  const tipo = partes[1].toLowerCase();
  if (!TIPOS.has(tipo)) return null;

  const bytes = Buffer.from(partes[2].replace(/\s+/g, ""), "base64");
  if (!bytes.length) return null;
  return { bytes, tipo };
}

/**
 * Endereço público desta imagem, para pôr num anúncio.
 *
 * `APP_URL` é o endereço deste deploy -- da instalação, não da organização --,
 * e é por isso que continua no ambiente. Sem ela não há endereço a oferecer, e
 * quem chama decide o que dizer.
 */
export function enderecoDaImagem(id: string): string | null {
  const base = process.env.APP_URL;
  if (!base) return null;
  try {
    return new URL(`/api/product-images/${encodeURIComponent(id)}`, base).toString();
  } catch {
    return null;
  }
}
