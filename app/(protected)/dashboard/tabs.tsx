"use client";

import { useState, type ReactNode } from "react";
import { Package, ShoppingCart } from "lucide-react";

/**
 * Abas do painel.
 *
 * Recebe o conteúdo já renderizado no servidor: só o estado da aba é do
 * cliente. Assim vendas e produtos continuam sendo consultados no servidor,
 * sem transformar o painel inteiro num componente de cliente por causa de um
 * botão.
 */
export function DashboardTabs({ vendas, produtos }: { vendas: ReactNode; produtos: ReactNode }) {
  const [aba, setAba] = useState<"vendas" | "produtos">("vendas");

  const abas = [
    { chave: "vendas" as const, rotulo: "Vendas", icone: ShoppingCart },
    { chave: "produtos" as const, rotulo: "Produtos", icone: Package },
  ];

  return (
    <div className="space-y-8">
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex gap-6">
          {abas.map(({ chave, rotulo, icone: Icone }) => (
            <button
              key={chave}
              onClick={() => setAba(chave)}
              aria-current={aba === chave ? "page" : undefined}
              className={`inline-flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${
                aba === chave
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
              }`}
            >
              <Icone size={16} />
              {rotulo}
            </button>
          ))}
        </nav>
      </div>

      {/* Os dois ficam montados e um é escondido: trocar de aba não refaz o
          gráfico do zero, e o estado de zoom e tooltip do recharts sobrevive. */}
      <div className={aba === "vendas" ? "space-y-8" : "hidden"}>{vendas}</div>
      <div className={aba === "produtos" ? "space-y-8" : "hidden"}>{produtos}</div>
    </div>
  );
}
