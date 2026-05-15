"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { upsertOrganization } from "./actions";
import { Plus, Pencil, Loader2 } from "lucide-react";

export function OrganizationForm({ defaultValues }: any) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const { register, handleSubmit, reset } = useForm({ defaultValues });

  const onSubmit = async (data: any) => {
    setIsPending(true);
    try {
      await upsertOrganization(data);
      setIsOpen(false);
      if (!defaultValues) reset();
      window.location.reload();
    } catch (e) { alert("Erro ao salvar"); }
    finally { setIsPending(false); }
  };

  return (
    <>
      <button onClick={() => setIsOpen(true)} className={defaultValues ? "p-2 hover:bg-gray-100 rounded-full" : "bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-2"}>
        {defaultValues ? <Pencil size={18} /> : <><Plus size={18} /> Nova Organização</>}
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold mb-4">{defaultValues ? "Editar" : "Nova"} Organização</h2>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <input {...register("name", { required: true })} placeholder="Nome da Empresa" className="w-full border p-2 rounded-lg" />
              <div className="flex gap-2">
                <button type="button" onClick={() => setIsOpen(false)} className="flex-1 py-2 border rounded-lg">Cancelar</button>
                <button type="submit" disabled={isPending} className="flex-1 bg-blue-600 text-white py-2 rounded-lg flex justify-center">
                  {isPending ? <Loader2 className="animate-spin" /> : "Salvar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}