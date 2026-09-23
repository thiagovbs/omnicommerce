/**
 * Uma imagem do álbum, como o formulário a enxerga.
 *
 * `id` presente = já está no banco. É por ele que o álbum é referenciado no
 * salvamento, em vez de a foto viajar de novo em base64 -- e é o mesmo id que
 * compõe o endereço público `/api/product-images/{id}` usado nos anúncios.
 * Sem `id`, é arquivo recém-convertido, que ainda precisa ser anexado.
 */
export interface ImagemDoAlbum {
  id?: string;
  /// Endereço para exibir: a URL gravada, ou um endereço local do navegador
  /// enquanto a foto ainda não subiu.
  url: string;
  /// Arquivo escolhido e ainda não enviado. Sobe como `FormData` no
  /// salvamento -- argumento de Server Action não aguenta a foto em texto.
  file?: File;
}

/// Formas planas para o cliente. Decimal do Prisma não atravessa a fronteira
/// servidor-cliente, e arredondar para Number perderia casas: preço viaja como
/// string, formatado uma vez só, no servidor.
export interface ListingRow {
  id: string;
  status: "DRAFT" | "PUBLISHING" | "PUBLISHED" | "FAILED" | "PAUSED" | "CLOSED";
  needsSync: boolean;
  externalListingId: string | null;
  /// Categoria escolhida neste canal, no identificador do provedor.
  categoryExternalId: string | null;
  /// Conta do provedor em que este anúncio está (ou vai) publicado.
  conta: string | null;
  /// Estado do anúncio nas palavras do provedor. "active" é o que está no ar.
  externalStatus: string | null;
  publishedPrice: string | null;
  publishedStock: number | null;
  lastPublishedAt: string | null;
  lastError: string | null;
  marketplace: { id: string; name: string; code: string };
}

export interface ProductRow {
  id: string;
  sku: string;
  title: string;
  description: string;
  category: string;
  brand: string;
  condition: string;
  /// Álbum na ordem do banco. A primeira é a principal, e é a que vai para
  /// provedores que aceitam uma imagem só.
  images: ImagemDoAlbum[];
  price: string;
  currency: string;
  stock: number;
  active: boolean;
  listings: ListingRow[];
}

export interface ChannelRow {
  id: string;
  name: string;
  code: string;
  /// Um canal sem provedor ou sem conexão não pode receber publicação. A tela
  /// mostra o motivo em vez de oferecer um botão que falharia depois.
  publicavel: boolean;
  motivo: string | null;
  /// Contas conectadas neste canal. Com mais de uma, a tela obriga a escolher
  /// antes de publicar -- é o que impede um anúncio ir para a conta errada.
  contas: { id: string; externalAccountId: string }[];
}
