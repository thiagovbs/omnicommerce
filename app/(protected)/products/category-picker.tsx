"use client";

import { useEffect, useState } from "react";
import { Check, ChevronRight, Loader2, RefreshCw, Search, X } from "lucide-react";
import {
  buscarCategorias, canaisComCategoria, definirCategoria, filhosDaCategoria, importarCategorias,
} from "./actions";
import type { ProductRow } from "./types";

interface No {
  externalId: string;
  name: string;
  leaf: boolean;
  path: string;
  listingAllowed: boolean;
}

interface Canal {
  id: string;
  name: string;
  temArvore: boolean;
  total: number;
  syncedAt: string | null;
  temProvedor: boolean;
}

/**
 * Escolha de categoria por canal.
 *
 * Dois caminhos para o mesmo destino: descer a árvore nível a nível, que é
 * como o provedor a organiza, e buscar por texto, que é o que funciona quando
 * são 12 mil categorias e sete níveis de profundidade.
 */
export function CategoryPicker({ produto }: { produto: ProductRow }) {
  const [canais, setCanais] = useState<Canal[]>([]);
  const [canal, setCanal] = useState<string>("");
  const [trilha, setTrilha] = useState<No[]>([]);
  const [nivel, setNivel] = useState<No[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [termo, setTermo] = useState("");
  const [achados, setAchados] = useState<No[] | null>(null);
  const [aviso, setAviso] = useState<{ erro: boolean; texto: string } | null>(null);
  const [importando, setImportando] = useState(false);

  const canalAtual = canais.find((c) => c.id === canal);
  // A escolha já gravada aparece pelo anúncio daquele canal.
  const escolhida = produto.listings.find((l) => l.marketplace.id === canal)?.categoryExternalId ?? null;

  // Só na montagem. A troca de canal é tratada no próprio evento: um efeito
  // que reagisse à mudança de estado seria mais difícil de seguir e é o que o
  // compilador do React desaconselha.
  useEffect(() => {
    void (async () => {
      const lista = await canaisComCategoria();
      const primeiro = lista.find((c) => c.temArvore);
      // As raízes vêm junto, para a tela não aparecer vazia por um instante.
      const raizes = primeiro ? await filhosDaCategoria(primeiro.id, null) : null;
      setCanais(lista);
      if (primeiro) setCanal(primeiro.id);
      if (raizes?.ok) setNivel(raizes.itens);
    })();
  }, []);

  /// Trocar de canal zera a navegação: trilha e busca são do canal anterior e
  /// não significam nada no novo.
  async function trocarCanal(marketplaceId: string) {
    setCanal(marketplaceId);
    setTrilha([]);
    setAchados(null);
    setTermo("");
    setNivel([]);
    if (marketplaceId) await abrir(marketplaceId, null);
  }

  async function abrir(marketplaceId: string, parent: string | null) {
    setCarregando(true);
    const resultado = await filhosDaCategoria(marketplaceId, parent);
    setCarregando(false);
    if (!resultado.ok) { setAviso({ erro: true, texto: resultado.erro }); return; }
    setNivel(resultado.itens);
  }

  async function descer(no: No) {
    if (no.leaf) { await gravar(no); return; }
    setTrilha([...trilha, no]);
    await abrir(canal, no.externalId);
  }

  async function voltarPara(indice: number) {
    const nova = trilha.slice(0, indice);
    setTrilha(nova);
    await abrir(canal, nova.length ? nova[nova.length - 1].externalId : null);
  }

  async function gravar(no: No | null) {
    const resultado = await definirCategoria(produto.id, canal, no?.externalId ?? null);
    setAviso(resultado.ok
      ? { erro: false, texto: no ? `Categoria definida: ${no.path}` : "Categoria removida." }
      : { erro: true, texto: resultado.erro });
    if (resultado.ok) window.location.reload();
  }

  async function buscar() {
    if (!termo.trim()) { setAchados(null); return; }
    setCarregando(true);
    const resultado = await buscarCategorias(canal, termo.trim());
    setCarregando(false);
    if (!resultado.ok) { setAviso({ erro: true, texto: resultado.erro }); return; }
    setAchados(resultado.itens.map((i) => ({ ...i, leaf: true, listingAllowed: true })));
  }

  if (!canais.length) {
    return <div className="py-8 text-center text-sm text-gray-400">Carregando canais…</div>;
  }

  return (
    <div className="space-y-4">
      {aviso && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${
          aviso.erro ? "border-red-200 bg-red-50 text-red-800" : "border-green-200 bg-green-50 text-green-800"
        }`}>
          {aviso.texto}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Canal</label>
        <div className="flex gap-2">
          <select
            value={canal} onChange={(evento) => void trocarCanal(evento.target.value)}
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">Selecione…</option>
            {canais.map((c) => (
              <option key={c.id} value={c.id} disabled={!c.temArvore}>
                {c.name}
                {!c.temProvedor ? " — sem árvore de categorias"
                  : !c.temArvore ? " — árvore não importada" : ` — ${c.total.toLocaleString("pt-BR")} categorias`}
              </option>
            ))}
          </select>
          <button
            type="button" disabled={importando}
            onClick={async () => {
              setImportando(true);
              const resultado = await importarCategorias();
              setImportando(false);
              setAviso(resultado.ok
                ? { erro: false, texto: `Importação concluída em ${resultado.canais} canal(is).` }
                : { erro: true, texto: resultado.erro });
              if (resultado.ok) setCanais(await canaisComCategoria());
            }}
            className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            title="Reimporta a árvore dos canais conectados que ainda não a têm"
          >
            {importando ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Importar
          </button>
        </div>
        {canalAtual?.syncedAt && (
          <p className="text-xs text-gray-400 mt-1">
            Árvore importada em {new Date(canalAtual.syncedAt).toLocaleString("pt-BR")}.
          </p>
        )}
      </div>

      {canal && canalAtual?.temArvore && (
        <>
          {escolhida && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
              <div className="text-sm text-blue-900">
                <Check size={14} className="inline mr-1" />
                Categoria atual: <span className="font-mono">{escolhida}</span>
              </div>
              <button
                type="button" onClick={() => void gravar(null)}
                className="text-xs font-medium text-blue-800 hover:text-red-600"
              >
                Remover
              </button>
            </div>
          )}

          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={termo}
                onChange={(evento) => setTermo(evento.target.value)}
                onKeyDown={(evento) => {
                  if (evento.key !== "Enter") return;
                  evento.preventDefault();
                  void buscar();
                }}
                placeholder="Buscar categoria por nome…"
                className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-8 text-sm"
              />
              {termo && (
                <button
                  type="button"
                  onClick={() => { setTermo(""); setAchados(null); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <button
              type="button" onClick={() => void buscar()}
              className="px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Buscar
            </button>
          </div>

          {achados === null && trilha.length > 0 && (
            <nav className="flex flex-wrap items-center gap-1 text-xs text-gray-500">
              <button type="button" onClick={() => void voltarPara(0)} className="hover:text-gray-900">
                Início
              </button>
              {trilha.map((no, i) => (
                <span key={no.externalId} className="flex items-center gap-1">
                  <ChevronRight size={12} />
                  <button
                    type="button" onClick={() => void voltarPara(i + 1)}
                    className="hover:text-gray-900"
                  >
                    {no.name}
                  </button>
                </span>
              ))}
            </nav>
          )}

          <div className="max-h-72 overflow-y-auto rounded-lg border border-gray-200 divide-y">
            {carregando && (
              <div className="flex items-center gap-2 px-4 py-6 text-sm text-gray-400">
                <Loader2 size={14} className="animate-spin" /> Carregando…
              </div>
            )}
            {!carregando && (achados ?? nivel).map((no) => (
              <button
                key={no.externalId} type="button"
                onClick={() => void descer(no)}
                disabled={no.leaf && !no.listingAllowed}
                className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-gray-50 disabled:opacity-40"
              >
                <span className="min-w-0">
                  <span className="text-gray-900">{no.name}</span>
                  {achados && <span className="block truncate text-xs text-gray-400">{no.path}</span>}
                </span>
                {no.leaf ? (
                  <span className="shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-800">
                    {no.listingAllowed ? "Escolher" : "Fechada"}
                  </span>
                ) : (
                  <ChevronRight size={14} className="shrink-0 text-gray-400" />
                )}
              </button>
            ))}
            {!carregando && !(achados ?? nivel).length && (
              <div className="px-4 py-6 text-sm text-gray-400">
                {achados ? "Nenhuma categoria encontrada." : "Nada neste nível."}
              </div>
            )}
          </div>

          <p className="text-xs text-gray-500">
            Só a subcategoria final recebe anúncio — as intermediárias servem para navegar.
            A escolha vale para este canal; outros canais têm a própria.
          </p>
        </>
      )}

      {canal && canalAtual && !canalAtual.temArvore && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {canalAtual.temProvedor
            ? "A árvore deste canal ainda não foi importada. Ela é baixada sozinha depois da autorização; use Importar para refazer agora."
            : "Este canal não tem árvore de categorias no provedor."}
        </div>
      )}
    </div>
  );
}
