"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { upsertMarketplace } from "./actions";
import { Plus, Pencil, Loader2 } from "lucide-react";

interface MarketplaceFormProps {
  organizationId: string;
  defaultValues?: {
    id: string;
    name: string;
    code: string;
    active: boolean;
  };
}

export function MarketplaceForm({ organizationId, defaultValues }: MarketplaceFormProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  
  const { register, handleSubmit, reset } = useForm({
    defaultValues: defaultValues || {
      name: "",
      code: "",
      active: true
    }
  });

  const onSubmit = async (data: any) => {
    setIsPending(true);
    try {
      await upsertMarketplace({
        ...data,
        id: defaultValues?.id,
        organizationId
      });
      setIsOpen(false);
      if (!defaultValues) reset();
      window.location.reload(); // Revalidação simples
    } catch (error) {
      alert("Erro ao salvar marketplace");
    } finally {
      setIsPending(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className={defaultValues 
          ? "p-2 hover:bg-gray-100 rounded-full" 
          : "flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"}
      >
        {defaultValues ? <Pencil size={18} /> : <><Plus size={18} /> Novo Marketplace</>}
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b">
              <h2 className="text-xl font-semibold">
                {defaultValues ? "Editar Marketplace" : "Cadastrar Marketplace"}
              </h2>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nome Comercial</label>
                <input
                  {...register("name", { required: true })}
                  placeholder="Ex: Mercado Livre"
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Código de Integração</label>
                <input
                  {...register("code", { required: true })}
                  placeholder="Ex: ml_oficial"
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  disabled={!!defaultValues} // O código geralmente é uma chave única que não muda
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  {...register("active")}
                  id="active"
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded"
                />
                <label htmlFor="active" className="text-sm font-medium text-gray-700">Marketplace Ativo</label>
              </div>

              <div className="flex gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="flex-1 px-4 py-2 border rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
                >
                  {isPending && <Loader2 className="animate-spin" size={18} />}
                  {defaultValues ? "Salvar Alterações" : "Criar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}