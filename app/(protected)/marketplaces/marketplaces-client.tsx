"use client";

import { MarketplaceForm } from "./marketplace-form";
import { excluirCanal } from "./actions";
import { rotuloDoProvedor } from "@/lib/domain/marketplace-config";
import { Trash2 } from "lucide-react";
import type { MarketplaceRow } from "./types";

export function MarketplacesClient({ initialData }: { initialData: MarketplaceRow[] }) {
  return (
    <div className="max-w-5xl mx-auto p-8">
      <div className="flex justify-between items-end mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Marketplaces</h1>
          <p className="text-gray-500 mt-1">Gerencie suas conexões de venda.</p>
        </div>
        <MarketplaceForm />
      </div>

      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-gray-50/50 border-b border-gray-200">
              <th className="px-6 py-4 text-sm font-semibold text-gray-900">Nome</th>
              <th className="px-6 py-4 text-sm font-semibold text-gray-900">Provedor</th>
              <th className="px-6 py-4 text-sm font-semibold text-gray-900">Configuração</th>
              <th className="px-6 py-4 text-sm font-semibold text-gray-900">Status</th>
              <th className="px-6 py-4 text-sm font-semibold text-gray-900 text-right">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {initialData.map((mp) => (
              <tr key={mp.id} className="hover:bg-gray-50/50 transition-colors group">
                <td className="px-6 py-4 text-sm text-gray-900 font-medium">{mp.name}</td>
                <td className="px-6 py-4 text-sm text-gray-700">
                  {mp.provider ? rotuloDoProvedor(mp.provider)
                    : <span className="text-amber-700">sem provedor</span>}
                  <div className="font-mono text-xs text-gray-400">{mp.code}</div>
                </td>
                {/* O que falta preencher aparece na LISTA, e não só ao abrir o
                    formulário: um canal pela metade é indistinguível de um
                    canal pronto até alguém tentar publicar. */}
                <td className="px-6 py-4 text-sm">
                  {!mp.provider ? <span className="text-gray-400">—</span>
                    : mp.falta.length === 0
                      ? <span className="text-green-700">Completa</span>
                      : <span className="text-amber-700">Falta: {mp.falta.join(", ")}</span>}
                </td>
                <td className="px-6 py-4">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    mp.active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
                  }`}>
                    {mp.active ? "Ativo" : "Inativo"}
                  </span>
                </td>
                <td className="px-6 py-4 text-right flex justify-end gap-2">
                  <MarketplaceForm defaultValues={mp} />
                  <button 
                    onClick={async () => {
                      if(confirm("Deseja realmente excluir?")) {
                        await excluirCanal(mp.id);
                        window.location.reload();
                      }
                    }}
                    className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-full transition-all"
                  >
                    <Trash2 size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {initialData.length === 0 && (
          <div className="p-12 text-center text-gray-500">
            Nenhum marketplace cadastrado.
          </div>
        )}
      </div>
    </div>
  );
}