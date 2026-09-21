"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Loader2 } from "lucide-react";
import { upsertOrganization } from "./actions";

export interface OrganizationValues {
  id: string;
  name: string;
  legalName: string;
  taxId: string;
  email: string;
  phone: string;
  zipCode: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
}

type Campos = Omit<OrganizationValues, "id">;

const VAZIO: Campos = {
  name: "", legalName: "", taxId: "", email: "", phone: "",
  zipCode: "", street: "", number: "", complement: "", district: "", city: "", state: "",
};

/**
 * Cadastro da organização.
 *
 * Os dados moram aqui porque são DE UMA organização, e o mesmo deploy atende
 * várias: variável de ambiente serviria a todas ao mesmo tempo. Quem consome
 * lê pela organização do usuário logado — o anúncio da OLX, por exemplo, usa
 * daqui o telefone e o CEP do anunciante.
 *
 * Nenhum campo além do nome é obrigatório: a organização nasce com o nome e
 * ganha o resto quando precisa. Quem exige um campo é quem o usa, e a mensagem
 * de lá aponta para esta tela.
 */
export function OrganizationForm({ defaultValues }: { defaultValues?: OrganizationValues }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const { register, handleSubmit, reset } = useForm<Campos>({
    defaultValues: defaultValues
      ? {
        name: defaultValues.name, legalName: defaultValues.legalName,
        taxId: defaultValues.taxId, email: defaultValues.email, phone: defaultValues.phone,
        zipCode: defaultValues.zipCode, street: defaultValues.street,
        number: defaultValues.number, complement: defaultValues.complement,
        district: defaultValues.district, city: defaultValues.city, state: defaultValues.state,
      }
      : VAZIO,
  });

  const onSubmit = async (data: Campos) => {
    setIsPending(true);
    setError("");
    try {
      const result = await upsertOrganization({ id: defaultValues?.id, ...data });
      if (!result.ok) { setError(result.error); return; }
      setIsOpen(false);
      if (!defaultValues) reset();
      router.refresh();
    } catch { setError("Falha de comunicação. Tente novamente."); }
    finally { setIsPending(false); }
  };

  const campo = "w-full border p-2 rounded-lg";
  const rotulo = "block text-xs font-medium text-gray-600 mb-1";

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
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold">{defaultValues ? "Editar" : "Nova"} Organização</h2>
            <p className="mt-1 mb-4 text-sm text-gray-500">
              Dados da empresa. Só o nome é obrigatório — o resto é exigido por quem
              usa: publicar classificado na OLX, por exemplo, precisa do telefone e do CEP.
            </p>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={rotulo}>Nome de exibição *</label>
                  <input {...register("name", { required: true })} placeholder="Empresa" className={campo} />
                </div>
                <div>
                  <label className={rotulo}>Razão social</label>
                  <input {...register("legalName")} placeholder="Empresa Comércio LTDA" className={campo} />
                </div>
                <div>
                  <label className={rotulo}>CNPJ</label>
                  {/* Guardado só com dígitos. A conferência dos dígitos
                      verificadores acontece no servidor, porque um CNPJ errado
                      só apareceria na nota do cliente. */}
                  <input {...register("taxId")} inputMode="numeric" placeholder="00.000.000/0000-00" className={campo} />
                </div>
                <div>
                  <label className={rotulo}>E-mail</label>
                  <input {...register("email")} type="email" placeholder="contato@empresa.com.br" className={campo} />
                </div>
                <div>
                  <label className={rotulo}>Telefone</label>
                  <input {...register("phone")} inputMode="numeric" placeholder="(11) 90000-0000" className={campo} />
                </div>
                <div>
                  <label className={rotulo}>CEP</label>
                  <input {...register("zipCode")} inputMode="numeric" placeholder="00000-000" className={campo} />
                </div>
              </div>

              <div className="grid grid-cols-6 gap-3">
                <div className="col-span-4">
                  <label className={rotulo}>Logradouro</label>
                  <input {...register("street")} placeholder="Rua, avenida…" className={campo} />
                </div>
                <div>
                  <label className={rotulo}>Número</label>
                  <input {...register("number")} className={campo} />
                </div>
                <div>
                  <label className={rotulo}>Complemento</label>
                  <input {...register("complement")} className={campo} />
                </div>
                <div className="col-span-3">
                  <label className={rotulo}>Bairro</label>
                  <input {...register("district")} className={campo} />
                </div>
                <div className="col-span-2">
                  <label className={rotulo}>Cidade</label>
                  <input {...register("city")} className={campo} />
                </div>
                <div>
                  <label className={rotulo}>UF</label>
                  <input {...register("state")} maxLength={2} placeholder="SP" className={campo} />
                </div>
              </div>

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
