"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { Loader2, Pencil, Plus } from "lucide-react";
import { salvarProduto } from "./actions";
import type { ProductRow } from "./types";

interface Campos {
  sku: string;
  title: string;
  description: string;
  category: string;
  brand: string;
  condition: string;
  imageUrl: string;
  price: string;
  stock: number;
  active: boolean;
}

const vazio: Campos = {
  sku: "", title: "", description: "", category: "", brand: "",
  condition: "novo", imageUrl: "", price: "", stock: 0, active: true,
};

export function ProductForm({ produto }: { produto?: ProductRow }) {
  const [aberto, setAberto] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const { register, handleSubmit, reset } = useForm<Campos>({
    defaultValues: produto
      ? {
        sku: produto.sku, title: produto.title, description: produto.description,
        category: produto.category, brand: produto.brand, condition: produto.condition,
        imageUrl: produto.imageUrl, price: produto.price, stock: produto.stock, active: produto.active,
      }
      : vazio,
  });

  async function enviar(dados: Campos) {
    setSalvando(true);
    setErro(null);
    try {
      const salvo = await salvarProduto({ ...dados, stock: Number(dados.stock) }, produto?.id);
      if (!salvo.ok) { setErro(salvo.erro); return; }
      // Publicar é um passo à parte, pelos botões da linha: salvar no catálogo
      // e anunciar no canal são decisões diferentes, e juntá-las esconderia a
      // segunda atrás da primeira.
      setAberto(false);
      if (!produto) reset(vazio);
      window.location.reload();
    } catch {
      setErro("Não foi possível salvar o produto.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setAberto(true)}
        className={produto
          ? "p-2 hover:bg-gray-100 rounded-full text-gray-400 hover:text-gray-700"
          : "flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"}
        aria-label={produto ? "Editar produto" : undefined}
      >
        {produto ? <Pencil size={18} /> : <><Plus size={18} /> Novo produto</>}
      </button>

      {aberto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b">
              <h2 className="text-xl font-semibold">{produto ? "Editar produto" : "Novo produto"}</h2>
              <p className="text-sm text-gray-500 mt-1">
                Preço e estoque daqui são o que vai para os canais publicados.
              </p>
            </div>

            <form onSubmit={handleSubmit(enviar)} className="p-6 space-y-4">
              {erro && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{erro}</div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">SKU</label>
                  <input
                    {...register("sku", { required: true })}
                    placeholder="LIVRO-001"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Liga o item vendido de volta ao catálogo. Letras, números, ponto, hífen e sublinhado.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Preço</label>
                  <input
                    {...register("price", { required: true })}
                    inputMode="decimal" placeholder="49.90"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Título</label>
                <input
                  {...register("title", { required: true })} maxLength={60}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Até 60 caracteres, que é o limite do provedor mais restrito.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Descrição</label>
                <textarea
                  {...register("description")} rows={3}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Categoria</label>
                  <input {...register("category")} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Marca</label>
                  <input {...register("brand")} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Condição</label>
                  <input {...register("condition")} placeholder="novo" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Estoque</label>
                  <input
                    type="number" min={0} {...register("stock", { valueAsNumber: true })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">URL da imagem</label>
                  <input
                    {...register("imageUrl")} placeholder="https://..."
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <p className="text-xs text-gray-500 mt-1">Precisa ser https: o provedor busca pelo servidor dele.</p>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" {...register("active")} className="rounded border-gray-300" />
                Produto ativo
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button" onClick={() => setAberto(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancelar
                </button>
                <button
                  type="submit" disabled={salvando}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {salvando && <Loader2 size={16} className="animate-spin" />}
                  Salvar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
