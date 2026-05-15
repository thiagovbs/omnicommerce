"use client";

import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell 
} from "recharts";

const COLORS = ["#2563eb", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

export function DashboardCharts({ stats }: { stats: any }) {
  // Dados para o Gráfico de Comparação (Bruto vs Líquido)
  const comparisonData = [
    { name: "Financeiro", Bruto: stats.totalGross, Líquido: stats.totalNet }
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Gráfico de Comparação Bruto vs Líquido */}
      <div className="bg-white p-6 rounded-xl border shadow-sm h-[400px]">
        <h3 className="text-lg font-semibold mb-6">Comparativo Financeiro</h3>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={comparisonData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" hide />
            <YAxis tickFormatter={(value) => `R$ ${value}`} />
            <Tooltip formatter={(value) => `R$ ${Number(value).toLocaleString()}`} />
            <Legend />
            <Bar dataKey="Bruto" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            <Bar dataKey="Líquido" fill="#10b981" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Gráfico de Distribuição por Marketplace */}
      <div className="bg-white p-6 rounded-xl border shadow-sm h-[400px]">
        <h3 className="text-lg font-semibold mb-6">Marketshare por Canal (Líquido)</h3>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={stats.marketplaceStats}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              outerRadius={100}
              label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
            >
              {stats.marketplaceStats.map((entry: any, index: number) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(value) => `R$ ${Number(value).toLocaleString()}`} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}