"use client";

import { updateSaleStatus } from "./actions";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { allowedStatusChanges, OrderStatus } from "@/lib/domain/sale-status";

export function StatusSelect({ saleId, currentStatus, statusVersion }: { saleId: string; currentStatus: OrderStatus; statusVersion: number }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const handleChange = async (newStatus: string) => {
    setLoading(true);
    setError("");
    try {
      const result = await updateSaleStatus(saleId, newStatus, statusVersion);
      if (!result.ok) setError(result.error);
      router.refresh();
    } catch {
      setError("Erro ao atualizar status. Tente novamente.");
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
        aria-label="Status do pedido"
        value={currentStatus}
        disabled={loading || allowedStatusChanges(currentStatus).length === 0}
        onChange={(e) => handleChange(e.target.value)}
        className={`text-[10px] font-bold py-1 px-2 rounded-full border-none cursor-pointer focus:ring-2 focus:ring-blue-500 transition-colors ${getStatusColor(currentStatus)}`}
      >
        {[currentStatus, ...allowedStatusChanges(currentStatus)].map((status) => (
          <option key={status} value={status}>{status}</option>
        ))}
      </select>
      {error && <span role="alert" className="ml-2 max-w-xs text-xs text-red-600">{error}</span>}
    </div>
  );
}
