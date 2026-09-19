"use client";

import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { ChevronLeft, ChevronRight, ImageOff, Loader2, Pencil, Plus, Upload, X } from "lucide-react";
import { MAX_IMAGENS } from "@/lib/domain/product-input";
import { converterImagem, salvarProduto } from "./actions";
import type { ProductRow } from "./types";

interface Campos {
  sku: string;
  title: string;
  description: string;
  category: string;
  brand: string;
  condition: string;
  price: string;
  stock: number;
  active: boolean;
}

const vazio: Campos = {
  sku: "", title: "", description: "", category: "", brand: "",
  condition: "novo", price: "", stock: 0, active: true,
};

export function ProductForm({ produto }: { produto?: ProductRow }) {
  const [aberto, setAberto] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [enviandoImagem, setEnviandoImagem] = useState(false);
  // O álbum fica em estado local, e não no formulário: as imagens têm duas
  // origens (URL digitada e arquivo convertido no servidor) e a ordem é
  // manipulada por botões. Uma fonte só evita que as duas discordem.
  const [album, setAlbum] = useState<string[]>(produto?.images ?? []);
  const [urlNova, setUrlNova] = useState("");
  const arquivoRef = useRef<HTMLInputElement>(null);

  const { register, handleSubmit, reset } = useForm<Campos>({
    defaultValues: produto
      ? {
        sku: produto.sku, title: produto.title, description: produto.description,
        category: produto.category, brand: produto.brand, condition: produto.condition,
        price: produto.price, stock: produto.stock, active: produto.active,
      }
      : vazio,
  });

  const cheio = album.length >= MAX_IMAGENS;

  /// Acrescenta no fim. A ordem de entrada é a ordem do álbum, então a primeira
  /// imagem adicionada nasce sendo a principal.
  function acrescentar(url: string) {
    setErro(null);
    if (cheio) { setErro(`O álbum aceita no máximo ${MAX_IMAGENS} imagens.`); return; }
    if (album.includes(url)) { setErro("Essa imagem já está no álbum."); return; }
    setAlbum([...album, url]);
  }

  /// Converte no servidor: é lá que tipo e tamanho são conferidos de verdade.
  async function escolherArquivos(arquivos: FileList) {
    setEnviandoImagem(true);
    setErro(null);
    try {
      // Uma de cada vez: o limite do corpo da ação é por chamada, e mandar
      // várias juntas estouraria com poucos arquivos grandes.
      let atual = album;
      for (const arquivo of Array.from(arquivos)) {
        if (atual.length >= MAX_IMAGENS) { setErro(`O álbum aceita no máximo ${MAX_IMAGENS} imagens.`); break; }
        const corpo = new FormData();
        corpo.append("file", arquivo);
        const resultado = await converterImagem(corpo);
        if (!resultado.ok) { setErro(resultado.erro); break; }
        if (atual.includes(resultado.dataUri)) continue;
        atual = [...atual, resultado.dataUri];
        setAlbum(atual);
      }
    } catch {
      setErro("Não foi possível ler a imagem.");
    } finally {
      setEnviandoImagem(false);
      // Permite reenviar o mesmo arquivo depois de remover.
      if (arquivoRef.current) arquivoRef.current.value = "";
    }
  }

  /// Troca com o vizinho. Mover a posição 0 é o que redefine a principal, que
  /// é a imagem que vai para os provedores de imagem única.
  function mover(indice: number, passo: -1 | 1) {
    const destino = indice + passo;
    if (destino < 0 || destino >= album.length) return;
    const copia = [...album];
    [copia[indice], copia[destino]] = [copia[destino], copia[indice]];
    setAlbum(copia);
  }

  async function enviar(dados: Campos) {
    setSalvando(true);
    setErro(null);
    try {
      const salvo = await salvarProduto(
        { ...dados, images: album, stock: Number(dados.stock) }, produto?.id);
      if (!salvo.ok) { setErro(salvo.erro); return; }
      // Publicar é um passo à parte, pelos botões da linha: salvar no catálogo
      // e anunciar no canal são decisões diferentes, e juntá-las esconderia a
      // segunda atrás da primeira.
      setAberto(false);
      if (!produto) { reset(vazio); setAlbum([]); setUrlNova(""); }
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

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Estoque</label>
                <input
                  type="number" min={0} {...register("stock", { valueAsNumber: true })}
                  className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <label className="block text-sm font-medium text-gray-700">Álbum de imagens</label>
                  <span className="text-xs text-gray-400">{album.length} de {MAX_IMAGENS}</span>
                </div>

                {album.length > 0 && (
                  <div className="flex flex-wrap gap-3 mb-3">
                    {album.map((url, indice) => (
                      <div key={url} className="relative w-28">
                        <div className="h-28 w-28 rounded-lg border border-gray-200 overflow-hidden bg-gray-50">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url} alt={`Imagem ${indice + 1}`} className="h-full w-full object-cover" />
                        </div>
                        <button
                          type="button" onClick={() => setAlbum(album.filter((_, i) => i !== indice))}
                          className="absolute -right-1.5 -top-1.5 rounded-full bg-white border border-gray-300 p-1 text-gray-500 shadow-sm hover:text-red-600"
                          aria-label={`Remover imagem ${indice + 1}`}
                        >
                          <X size={12} />
                        </button>
                        <div className="mt-1 flex items-center justify-between">
                          <button
                            type="button" onClick={() => mover(indice, -1)} disabled={indice === 0}
                            className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                            aria-label="Mover para a esquerda"
                          >
                            <ChevronLeft size={14} />
                          </button>
                          {indice === 0 ? (
                            <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800">
                              Principal
                            </span>
                          ) : (
                            <span className="text-[10px] text-gray-400">{indice + 1}ª</span>
                          )}
                          <button
                            type="button" onClick={() => mover(indice, 1)} disabled={indice === album.length - 1}
                            className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                            aria-label="Mover para a direita"
                          >
                            <ChevronRight size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {album.length === 0 && (
                  <div className="mb-3 flex items-center gap-2 rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-sm text-gray-400">
                    <ImageOff size={18} /> Nenhuma imagem ainda.
                  </div>
                )}

                <div className="flex gap-2">
                  <input
                    value={urlNova}
                    onChange={(evento) => setUrlNova(evento.target.value)}
                    onKeyDown={(evento) => {
                      // Enter aqui acrescenta a imagem; sem isto ele enviaria o
                      // formulário inteiro no meio do cadastro do álbum.
                      if (evento.key !== "Enter") return;
                      evento.preventDefault();
                      if (urlNova.trim()) { acrescentar(urlNova.trim()); setUrlNova(""); }
                    }}
                    placeholder="https://..."
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
                  />
                  <button
                    type="button" disabled={!urlNova.trim() || cheio}
                    onClick={() => { acrescentar(urlNova.trim()); setUrlNova(""); }}
                    className="px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                  >
                    Adicionar URL
                  </button>
                  <input
                    ref={arquivoRef} type="file" multiple className="hidden"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                    onChange={(evento) => {
                      const arquivos = evento.target.files;
                      if (arquivos?.length) void escolherArquivos(arquivos);
                    }}
                  />
                  <button
                    type="button" disabled={enviandoImagem || cheio}
                    onClick={() => arquivoRef.current?.click()}
                    className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                  >
                    {enviandoImagem ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                    Enviar arquivos
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  A primeira imagem é a principal e é a única que vai para canais que aceitam
                  uma só, como o Sebo On-Line. URL precisa ser https; arquivo enviado fica
                  guardado no banco em base64, até 3 MB cada.
                </p>
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
