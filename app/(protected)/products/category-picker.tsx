"use client";

import { useEffect, useState } from "react";
import { Check, ChevronRight, Loader2, RefreshCw, Search, X } from "lucide-react";
import {
  buscarCategorias, canaisComCategoria, definirCategoria, filhosDaCategoria, importarCategorias,
} from "./actions";
import { AttributeFields } from "./attribute-fields";
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
  /// O provedor tem árvore a importar. Falso no Sebo On-Line, que usa a
  /// categoria em texto do produto.
  suportaArvore: boolean;
  /// Como este canal ganha categoria: árvore navegável, código digitado ou a
  /// categoria em texto livre do produto.
  modo: "arvore" | "codigo" | "texto-livre";
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
      // Prefere um canal com árvore, mas cai no primeiro: um canal de
      // categoria em texto também tem o que explicar, e deixar o seletor
      // vazio esconderia isso.
      const primeiro = lista.find((c) => c.temArvore) ?? lista[0];
      // As raízes vêm junto, para a tela não aparecer vazia por um instante.
      const raizes = primeiro?.temArvore ? await filhosDaCategoria(primeiro.id, null) : null;
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
              <option key={c.id} value={c.id}>
                {c.name}
                {!c.suportaArvore ? " — categoria em texto"
                  : !c.temArvore ? " — árvore não importada" : ` — ${c.total.toLocaleString("pt-BR")} categorias`}
              </option>
            ))}
          </select>
          <button
            type="button" disabled={importando || (!!canalAtual && !canalAtual.suportaArvore)}
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

      {canal && canalAtual?.suportaArvore && canalAtual.temArvore && (
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

          {/* A chave remonta o componente quando o canal muda: os atributos são
              da categoria daquele canal, e reaproveitar o estado misturaria os
              valores de um canal com as definições de outro. */}
          <AttributeFields key={`${produto.id}:${canal}`} productId={produto.id} marketplaceId={canal} />
        </>
      )}

      {canal && canalAtual?.modo === "codigo" && (
        // A chave remonta o campo ao trocar de canal: o código é daquele canal,
        // e reaproveitar o texto digitado misturaria um com o outro.
        <CodigoDeCategoria
          key={`${produto.id}:${canal}`}
          produto={produto} canal={canal} nomeDoCanal={canalAtual.name} atual={escolhida}
        />
      )}

      {canal && canalAtual?.modo === "texto-livre" && (
        <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-4 text-sm">
          <p className="text-gray-700">
            <span className="font-medium">{canalAtual.name}</span> não tem árvore de categorias:
            ele usa a categoria em <span className="font-medium">texto livre</span> do produto,
            a mesma para todos os canais assim.
          </p>
          <p className="text-gray-600">
            Categoria atual do produto:{" "}
            {produto.category
              ? <span className="rounded bg-white border border-gray-300 px-1.5 py-0.5 font-mono text-xs">{produto.category}</span>
              : <span className="text-gray-400">não informada</span>}
          </p>
          <p className="text-xs text-gray-500">
            Para alterá-la, use o campo Categoria na aba Dados. Não há o que importar aqui.
          </p>
        </div>
      )}

      {canal && canalAtual?.modo === "arvore" && !canalAtual.temArvore && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          A árvore deste canal ainda não foi importada. Ela é baixada sozinha depois da
          autorização; use Importar para refazer agora.
        </div>
      )}
    </div>
  );
}

/**
 * Categoria por código, para canal que exige a dele e cujo catálogo não
 * importamos (Shopee, OLX).
 *
 * Existe porque a alternativa era um beco: a publicação recusa sem categoria
 * do canal, a mensagem manda preencher aqui, e aqui não havia nada para
 * preencher. O código não é conferido contra árvore nenhuma -- quem valida é o
 * provedor, e a recusa dele chega na publicação, com as palavras dele.
 */
function CodigoDeCategoria({ produto, canal, nomeDoCanal, atual }: {
  produto: ProductRow;
  canal: string;
  nomeDoCanal: string;
  atual: string | null;
}) {
  const [codigo, setCodigo] = useState(atual ?? "");
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState<{ erro: boolean; texto: string } | null>(null);

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-4 text-sm">
      <p className="text-gray-700">
        <span className="font-medium">{nomeDoCanal}</span> exige o código da categoria dele,
        e a árvore deste canal não é importada por aqui. Informe o código numérico.
      </p>
      <div className="flex items-center gap-2">
        <input
          value={codigo}
          onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          maxLength={20}
          placeholder="ex.: 100182"
          className="w-40 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
        />
        <button
          type="button" disabled={salvando}
          onClick={async () => {
            setSalvando(true);
            setAviso(null);
            const resultado = await definirCategoria(produto.id, canal, codigo || null);
            setSalvando(false);
            setAviso(resultado.ok
              ? { erro: false, texto: codigo ? `Categoria ${codigo} gravada.` : "Categoria removida." }
              : { erro: true, texto: resultado.erro });
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {salvando ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          Salvar
        </button>
      </div>
      {atual && (
        <p className="text-xs text-gray-500">
          Gravado agora: <span className="font-mono">{atual}</span>
        </p>
      )}
      {aviso && (
        <p className={aviso.erro ? "text-sm text-red-700" : "text-sm text-green-700"}>{aviso.texto}</p>
      )}
    </div>
  );
}
