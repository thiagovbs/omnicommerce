"use client";

import { useForm, useFieldArray, useWatch } from "react-hook-form";
import { createSale } from "./actions";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function SaleForm({ marketplaces }: { marketplaces: { id: string; name: string }[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const { register, control, handleSubmit, reset } = useForm({
    defaultValues: {
      marketplaceId: "",
      externalOrderId: "",
      status: "CREATED",
      soldAt: new Date().toISOString().split('T')[0],
      shipping: 0,
      fees: 0,
      items: [{ title: "", quantity: 1, unitPrice: 0 }]
    }
  });

  const { fields, append, remove } = useFieldArray({ control, name: "items" });
  const watchedItems = useWatch({ control, name: "items" });
  const total = watchedItems.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);

  const onSubmit = async (data: unknown) => {
    setIsPending(true);
    setError("");
    try {
      const result = await createSale(data);
      if (!result.ok) { setError(result.error); return; }
      setIsOpen(false);
      reset();
      router.refresh();
    } catch {
      setError("Erro ao criar venda. Tente novamente.");
    } finally {
      setIsPending(false);
    }
  };

  if (!isOpen) return (
    <button onClick={() => setIsOpen(true)} className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-2">
      <Plus size={18} /> Nova Venda
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <form onSubmit={handleSubmit(onSubmit)} className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b sticky top-0 bg-white z-10 flex justify-between items-center">
          <h2 className="text-xl font-bold">Nova Venda</h2>
          <button type="button" onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-gray-600">X</button>
        </div>

        <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Informações da Venda */}
          <div>
            <label className="block text-sm font-medium mb-1">Marketplace</label>
            <select {...register("marketplaceId")} className="w-full border rounded-lg p-2">
              <option value="">Selecione...</option>
              {marketplaces.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">ID do Pedido</label>
            <input {...register("externalOrderId")} className="w-full border rounded-lg p-2" placeholder="Ex: MLB12345" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Data da Venda</label>
            <input type="date" {...register("soldAt")} className="w-full border rounded-lg p-2" />
          </div>

          <div className="md:col-span-3 border-t pt-4 mt-2">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-700">Produtos / Itens</h3>
              <button type="button" onClick={() => append({ title: "", quantity: 1, unitPrice: 0 })} className="text-blue-600 text-sm flex items-center gap-1">
                <Plus size={14} /> Adicionar Item
              </button>
            </div>
            
            {fields.map((field, index) => (
              <div key={field.id} className="grid grid-cols-12 gap-2 mb-2 items-end">
                <div className="col-span-6">
                  <input {...register(`items.${index}.title`)} placeholder="Título do produto" className="w-full border rounded-lg p-2 text-sm" />
                </div>
                <div className="col-span-2">
                  <input type="number" {...register(`items.${index}.quantity`)} placeholder="Qtd" className="w-full border rounded-lg p-2 text-sm" />
                </div>
                <div className="col-span-3">
                  <input type="number" step="0.01" {...register(`items.${index}.unitPrice`)} placeholder="Preço" className="w-full border rounded-lg p-2 text-sm" />
                </div>
                <div className="col-span-1 text-right">
                  <button type="button" onClick={() => remove(index)} className="p-2 text-red-500 hover:bg-red-50 rounded"><Trash2 size={16} /></button>
                </div>
              </div>
            ))}
          </div>

          {/* Financeiro */}
          <div className="md:col-span-3 border-t pt-4 grid grid-cols-3 gap-4 bg-gray-50 p-4 rounded-lg">
            <div>
              <label className="block text-sm font-medium text-gray-600">Valor Bruto (Produtos)</label>
              <input aria-label="Valor bruto calculado" readOnly value={Number.isFinite(total) ? total.toFixed(2) : ""} className="w-full border rounded-lg p-2 font-bold" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600">Frete</label>
              <input type="number" step="0.01" {...register("shipping")} className="w-full border rounded-lg p-2" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600">Taxas/Comissões</label>
              <input type="number" step="0.01" {...register("fees")} className="w-full border rounded-lg p-2" />
            </div>
          </div>
        </div>

        <div className="p-6 border-t flex gap-3">
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={isPending} className="flex-1 bg-green-600 text-white py-3 rounded-lg font-bold hover:bg-green-700 flex items-center justify-center gap-2">
            {isPending && <Loader2 className="animate-spin" />} Salvar Venda
          </button>
        </div>
      </form>
    </div>
  );
}
