"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Loader2 } from "lucide-react";
import { upsertOrganization } from "./actions";

interface OrganizationFormProps {
  defaultValues?: { id: string; name: string };
}

export function OrganizationForm({ defaultValues }: OrganizationFormProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const { register, handleSubmit, reset } = useForm({ defaultValues: { name: defaultValues?.name ?? "" } });

  const onSubmit = async (data: { name: string }) => {
    setIsPending(true);
    setError("");
    try {
      const result = await upsertOrganization({ id: defaultValues?.id, name: data.name });
      if (!result.ok) { setError(result.error); return; }
      setIsOpen(false);
      if (!defaultValues) reset();
      router.refresh();
    } catch { setError("Falha de comunicação. Tente novamente."); }
    finally { setIsPending(false); }
  };

  return (
    <>
      <button
        onClick={() => { setError(""); setIsOpen(true); }}
        aria-label={defaultValues ? "Editar " + defaultValues.name : "Nova organização"}
        className={defaultValues ? "p-2 hover:bg-gray-100 rounded-full" : "bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-2"}
      >
        {defaultValues ? <Pencil size={18} /> : <><Plus size={18} /> Nova Organização</>}
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold mb-4">{defaultValues ? "Editar" : "Nova"} Organização</h2>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <input {...register("name", { required: true })} placeholder="Nome da Empresa" className="w-full border p-2 rounded-lg" />
              {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
              <div className="flex gap-2">
                <button type="button" onClick={() => setIsOpen(false)} className="flex-1 py-2 border rounded-lg">Cancelar</button>
                <button type="submit" disabled={isPending} className="flex-1 bg-blue-600 text-white py-2 rounded-lg flex justify-center disabled:opacity-50">
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
