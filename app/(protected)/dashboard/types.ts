export interface MarketplaceStat {
  name: string;
  value: number;
  count: number;
}

export interface DashboardStats {
  totalGross: number;
  totalNet: number;
  totalOrders: number;
  marketplaceStats: MarketplaceStat[];
}

export interface ProductStats {
  total: number;
  ativos: number;
  semEstoque: number;
  unidades: number;
  /// String para não perder centavos ao atravessar para o cliente.
  valorEstoque: string;
  anunciosPublicados: number;
  anunciosComFalha: number;
  estoquePorDia: { dia: string; unidades: number }[];
  maisVendidos: { titulo: string; sku: string | null; unidades: number; receita: string }[];
  estoqueBaixo: { sku: string; titulo: string; estoque: number; preco: string }[];
}
