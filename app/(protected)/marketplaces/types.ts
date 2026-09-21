import type { MarketplaceProvider } from "@prisma/client";

export interface MarketplaceRow {
  id: string;
  name: string;
  code: string;
  /// Escolhido na lista suspensa. Nulo só em canal antigo, criado quando o
  /// código era texto livre e não casava com provedor nenhum.
  provider: MarketplaceProvider | null;
  active: boolean;
  /// Chaves de configuração já preenchidas. Para segredo, é só a existência --
  /// o valor nunca sai do servidor.
  preenchidas: string[];
  /// Rótulos do que é obrigatório e está em branco.
  falta: string[];
}

export interface MarketplaceInput {
  id?: string;
  name: string;
  provider: MarketplaceProvider;
  active: boolean;
  /// Só as chaves que o formulário enviou. Chave ausente não é pedido de
  /// remoção: é assunto que aquele envio não tocou.
  config: Record<string, string>;
}
