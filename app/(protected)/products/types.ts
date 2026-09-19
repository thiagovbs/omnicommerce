/// Formas planas para o cliente. Decimal do Prisma não atravessa a fronteira
/// servidor-cliente, e arredondar para Number perderia casas: preço viaja como
/// string, formatado uma vez só, no servidor.
export interface ListingRow {
  id: string;
  status: "DRAFT" | "PUBLISHING" | "PUBLISHED" | "FAILED" | "PAUSED" | "CLOSED";
  needsSync: boolean;
  externalListingId: string | null;
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
  imageUrl: string;
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
}
