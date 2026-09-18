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
