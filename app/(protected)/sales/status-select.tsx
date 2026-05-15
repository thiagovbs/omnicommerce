"use client";

import { updateSaleStatus } from "./actions";
import { useState } from "react";
import { Loader2 } from "lucide-react";

export function StatusSelect({ saleId, currentStatus }: { saleId: string, currentStatus: string }) {
  const [loading, setLoading] = useState(false);

  const handleChange = async (newStatus: string) => {
    setLoading(true);
    try {
      await updateSaleStatus(saleId, newStatus);
    } catch (error) {
      alert("Erro ao atualizar status");
    } finally {
      setLoading(false);
    }
  };

  // Função para definir a cor do badge com base no enum exato
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'PAID':
      case 'DELIVERED':
        return 'bg-green-100 text-green-700';
      case 'CANCELLED':
      case 'REFUNDED':
        return 'bg-red-100 text-red-700';
      case 'SHIPPED':
      case 'INVOICED':
        return 'bg-blue-100 text-blue-700';
      default: // CREATED
        return 'bg-amber-100 text-amber-700';
    }
  };

  return (
    <div className="relative flex items-center">
      {loading && <Loader2 className="absolute -left-6 animate-spin text-blue-600" size={16} />}
      <select
        defaultValue={currentStatus}
        disabled={loading}
        onChange={(e) => handleChange(e.target.value)}
        className={`text-[10px] font-bold py-1 px-2 rounded-full border-none cursor-pointer focus:ring-2 focus:ring-blue-500 transition-colors ${getStatusColor(currentStatus)}`}
      >
        <option value="CREATED">CREATED</option>
        <option value="PAID">PAID</option>
        <option value="INVOICED">INVOICED</option>
        <option value="SHIPPED">SHIPPED</option>
        <option value="DELIVERED">DELIVERED</option>
        <option value="CANCELLED">CANCELLED</option>
        <option value="REFUNDED">REFUNDED</option>
      </select>
    </div>
  );
}