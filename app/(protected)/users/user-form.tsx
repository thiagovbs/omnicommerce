"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { upsertUser } from "./actions";
import { Plus, Loader2 } from "lucide-react";

interface Organization {
  id: string;
  name: string;
}

export function UserForm({ organizations }: { organizations: Organization[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const { register, handleSubmit, reset } = useForm();

  const onSubmit = async (data: any) => {
    setIsPending(true);
    try {
      await upsertUser(data);
      setIsOpen(false);
      reset();
    } catch (e) {
      alert("Erro ao salvar usuário.");
    } finally {
      setIsPending(false);
    }
  };

  return (
    <>
      <button 
        onClick={() => setIsOpen(true)}
        className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-2 hover:bg-blue-700 transition-colors"
      >
        <Plus size={18} /> Novo Usuário
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-2xl">
            <h2 className="text-xl font-bold mb-4">Cadastrar Novo Membro</h2>
            
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Nome</label>
                <input {...register("name", { required: true })} className="w-full border rounded-lg p-2" placeholder="Nome completo" />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">E-mail</label>
                <input {...register("email", { required: true })} type="email" className="w-full border rounded-lg p-2" placeholder="exemplo@empresa.com" />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Organização (Empresa)</label>
                <select {...register("organizationId", { required: true })} className="w-full border rounded-lg p-2 bg-white">
                  <option value="">Selecione uma empresa...</option>
                  {organizations.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Cargo/Permissão</label>
                <select {...register("role")} className="w-full border rounded-lg p-2 bg-white">
                  <option value="OPERATOR">Operador</option>
                  <option value="ADMIN">Administrador</option>
                </select>
              </div>

              <div className="flex gap-3 mt-6">
                <button 
                  type="button" 
                  onClick={() => setIsOpen(false)}
                  className="flex-1 py-2 border rounded-lg hover:bg-gray-50"
                >
                  Cancelar
                </button>
                <button 
                  type="submit" 
                  disabled={isPending}
                  className="flex-1 bg-blue-600 text-white py-2 rounded-lg flex justify-center items-center"
                >
                  {isPending ? <Loader2 className="animate-spin" /> : "Criar Usuário"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}