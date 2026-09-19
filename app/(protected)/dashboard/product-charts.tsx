"use client";

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import type { ProductStats } from "./types";

const CORES = ["#2563eb", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#0ea5e9", "#ec4899", "#14b8a6"];

function real(valor: string | number) {
  return Number(valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/// dd/mm a partir do dia ISO, sem passar por Date: `new Date("2026-09-19")`
/// é lido como UTC e, em fuso negativo, volta um dia no eixo.
function diaCurto(dia: string) {
  const [, mes, d] = dia.split("-");
  return `${d}/${mes}`;
}

export function ProductCharts({ stats }: { stats: ProductStats }) {
  const vendidos = stats.maisVendidos.map((item) => ({
    nome: item.titulo.length > 28 ? item.titulo.slice(0, 27) + "…" : item.titulo,
    sku: item.sku,
    unidades: item.unidades,
    receita: Number(item.receita),
  }));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="bg-white p-6 rounded-xl border shadow-sm h-[380px]">
        <h3 className="text-lg font-semibold">Unidades em estoque por dia</h3>
        <p className="text-xs text-gray-400 mb-4">
          Reconstruído a partir dos movimentos de estoque dos últimos 30 dias.
        </p>
        <ResponsiveContainer width="100%" height="80%">
          <AreaChart data={stats.estoquePorDia} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="gradEstoque" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#2563eb" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="dia" tickFormatter={diaCurto} tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
            <Tooltip
              labelFormatter={(dia) => diaCurto(String(dia))}
              formatter={(valor) => [`${valor} unidades`, "Estoque"]}
            />
            <Area type="monotone" dataKey="unidades" stroke="#2563eb" strokeWidth={2} fill="url(#gradEstoque)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-white p-6 rounded-xl border shadow-sm h-[380px]">
        <h3 className="text-lg font-semibold">Produtos mais vendidos</h3>
        <p className="text-xs text-gray-400 mb-4">
          Por unidades, excluindo vendas canceladas.
        </p>
        {vendidos.length ? (
          <ResponsiveContainer width="100%" height="80%">
            <BarChart data={vendidos} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="nome" width={150} tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(valor, nome, item) => nome === "unidades"
                  ? [`${valor} unidades`, "Vendidas"]
                  : [real(item.payload.receita), "Receita"]}
              />
              <Bar dataKey="unidades" radius={[0, 4, 4, 0]}>
                {vendidos.map((_, i) => <Cell key={i} fill={CORES[i % CORES.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[80%] flex items-center justify-center text-sm text-gray-400">
            Nenhuma venda registrada ainda.
          </div>
        )}
      </div>
    </div>
  );
}

export function LowStockTable({ stats }: { stats: ProductStats }) {
  if (!stats.estoqueBaixo.length) {
    return (
      <div className="bg-white border rounded-xl shadow-sm p-12 text-center text-gray-400">
        Nenhum produto ativo no catálogo.
      </div>
    );
  }
  return (
    <div className="bg-white border rounded-xl shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b">
        <h3 className="text-lg font-semibold">Menor estoque</h3>
        <p className="text-xs text-gray-400">Produtos ativos, do que tem menos para o que tem mais.</p>
      </div>
      <table className="w-full text-left">
        <thead className="bg-gray-50/50 border-b">
          <tr>
            <th className="px-6 py-3 text-xs font-semibold text-gray-600">SKU</th>
            <th className="px-6 py-3 text-xs font-semibold text-gray-600">Produto</th>
            <th className="px-6 py-3 text-xs font-semibold text-gray-600 text-right">Preço</th>
            <th className="px-6 py-3 text-xs font-semibold text-gray-600 text-right">Estoque</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {stats.estoqueBaixo.map((p) => (
            <tr key={p.sku} className="hover:bg-gray-50/50">
              <td className="px-6 py-3 text-sm font-mono text-gray-500">{p.sku}</td>
              <td className="px-6 py-3 text-sm text-gray-900">{p.titulo}</td>
              <td className="px-6 py-3 text-sm text-right text-gray-700">{real(p.preco)}</td>
              <td className="px-6 py-3 text-sm text-right">
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                  p.estoque === 0 ? "bg-red-100 text-red-800"
                    : p.estoque <= 3 ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-700"
                }`}>
                  {p.estoque}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
