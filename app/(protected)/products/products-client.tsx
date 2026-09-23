"use client";

import { useState, useTransition } from "react";
import { AlertCircle, Check, ImageOff, Loader2, RefreshCw, Send, Trash2 } from "lucide-react";
import { ajustarEstoque, publicar, removerProduto, sincronizarAgora } from "./actions";
import { ProductForm } from "./product-form";
import type { ChannelRow, ListingRow, ProductRow } from "./types";

/// O estado do provedor, nas palavras dele, traduzido.
const ESTADO_DO_PROVEDOR: Record<string, string> = {
  active: "No ar",
  under_review: "Em revisão",
  paused: "Pausado no canal",
  closed: "Encerrado no canal",
  inactive: "Inativo no canal",
  payment_required: "Aguardando pagamento",
};

/**
 * Como cada estado de anúncio se mostra.
 *
 * `needsSync` tem precedência: um anúncio publicado e desatualizado não deve
 * parecer em dia. E o estado do PROVEDOR tem precedência sobre o nosso quando
 * eles discordam: o Mercado Livre aceita a criação e devolve `under_review`,
 * e mostrar "Publicado" faria parecer que se está vendendo quando o anúncio
 * ainda não apareceu.
 */
function selo(listing: ListingRow) {
  if (listing.status === "FAILED") {
    return { texto: "Falhou", classe: "bg-red-100 text-red-800" };
  }
  if (listing.needsSync) {
    return { texto: listing.status === "PUBLISHED" ? "Desatualizado" : "Publicando", classe: "bg-amber-100 text-amber-800" };
  }
  if (listing.status === "PUBLISHED") {
    const externo = listing.externalStatus;
    if (externo && externo !== "active") {
      return {
        texto: ESTADO_DO_PROVEDOR[externo] ?? externo,
        classe: "bg-amber-100 text-amber-800",
      };
    }
    return { texto: "No ar", classe: "bg-green-100 text-green-800" };
  }
  return { texto: listing.status === "PAUSED" ? "Pausado" : "Rascunho", classe: "bg-gray-100 text-gray-700" };
}

function moeda(valor: string, currency: string) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(Number(valor));
}

export function ProductsClient({ produtos, canais }: { produtos: ProductRow[]; canais: ChannelRow[] }) {
  const [aviso, setAviso] = useState<{ erro: boolean; texto: string } | null>(null);
  const [pendente, startTransition] = useTransition();
  const [emFoco, setEmFoco] = useState<string | null>(null);
  // Conta escolhida por canal, só para os canais com mais de uma conectada.
  // Sem escolha, publicar é recusado no serviço: adivinhar aqui poderia mandar
  // o anúncio para a conta real quando se queria a de teste.
  const [conta, setConta] = useState<Record<string, string>>({});

  const publicaveis = canais.filter((c) => c.publicavel);

  function rodar(acao: () => Promise<{ ok: boolean; erro?: string }>, sucesso: (r: never) => string) {
    startTransition(async () => {
      const resultado = await acao();
      setAviso(resultado.ok
        ? { erro: false, texto: sucesso(resultado as never) }
        : { erro: true, texto: resultado.erro ?? "Falhou." });
    });
  }

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 lg:p-8">
      <div className="flex justify-between items-end mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Produtos</h1>
          <p className="text-gray-500 mt-1">
            O catálogo é a fonte da verdade: preço e estoque daqui são empurrados para os canais.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => rodar(
              () => sincronizarAgora(),
              (r: { publicados: number; atualizados: number; emDia: number; falhas: number }) =>
                `${r.publicados} publicado(s), ${r.atualizados} atualizado(s), ${r.emDia} já em dia, ${r.falhas} falha(s).`)}
            disabled={pendente}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            {pendente ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Sincronizar pendentes
          </button>
          <ProductForm />
        </div>
      </div>

      {aviso && (
        <div className={`mb-6 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${
          aviso.erro ? "border-red-200 bg-red-50 text-red-800" : "border-green-200 bg-green-50 text-green-800"
        }`}>
          {aviso.erro ? <AlertCircle size={18} className="mt-0.5 shrink-0" /> : <Check size={18} className="mt-0.5 shrink-0" />}
          <span>{aviso.texto}</span>
        </div>
      )}

      {canais.some((c) => !c.publicavel) && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
          Canais indisponíveis para publicação:{" "}
          {canais.filter((c) => !c.publicavel).map((c) => `${c.name} (${c.motivo})`).join(", ")}.
        </div>
      )}

      <div className="space-y-4">
        {produtos.map((produto) => (
          <div key={produto.id} className="bg-white border border-gray-200 rounded-xl shadow-sm">
            <div className="flex items-start justify-between gap-4 p-6">
              <div className="flex min-w-0 items-start gap-4">
                {produto.images[0] ? (
                  <div className="relative shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={produto.images[0].url} alt=""
                      className="h-14 w-14 rounded-lg border border-gray-200 object-cover"
                    />
                    {produto.images.length > 1 && (
                      <span className="absolute -right-1.5 -top-1.5 rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        {produto.images.length}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-50">
                    <ImageOff size={18} className="text-gray-300" />
                  </div>
                )}
                <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-semibold text-gray-900 truncate">{produto.title}</h2>
                  <span className="font-mono text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">{produto.sku}</span>
                  {!produto.active && (
                    <span className="text-xs font-medium text-red-800 bg-red-100 px-2 py-0.5 rounded-full">Inativo</span>
                  )}
                </div>
                <p className="text-sm text-gray-500 mt-1">
                  {moeda(produto.price, produto.currency)}
                  {produto.category && <> · {produto.category}</>}
                  {produto.brand && <> · {produto.brand}</>}
                </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <label className="text-sm text-gray-500">Estoque</label>
                <input
                  type="number" min={0} defaultValue={produto.stock}
                  onFocus={() => setEmFoco(produto.id)}
                  onBlur={(evento) => {
                    setEmFoco(null);
                    const novo = Number(evento.target.value);
                    if (novo === produto.stock) return;
                    rodar(
                      () => ajustarEstoque(produto.id, novo),
                      (r: { stock: number; anuncios: number }) =>
                        `Estoque de ${produto.sku}: ${r.stock}.` +
                        (r.anuncios ? ` ${r.anuncios} anúncio(s) para ressincronizar.` : ""));
                  }}
                  className={`w-20 rounded-lg border px-3 py-1.5 text-sm ${
                    emFoco === produto.id ? "border-blue-400 ring-2 ring-blue-100" : "border-gray-300"
                  }`}
                />
                <ProductForm produto={produto} />
                <button
                  onClick={() => {
                    if (!confirm(`Remover ${produto.sku} do catálogo?`)) return;
                    rodar(() => removerProduto(produto.id), () => `${produto.sku} removido.`);
                  }}
                  className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-full transition-all"
                  aria-label="Remover produto"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>

            <div className="border-t border-gray-200 bg-gray-50/50 px-6 py-4">
              <div className="flex flex-wrap items-center gap-3">
                {produto.listings.length === 0 && (
                  <span className="text-sm text-gray-500">Não publicado em nenhum canal.</span>
                )}
                {produto.listings.map((listing) => {
                  const marca = selo(listing);
                  return (
                    <div key={listing.id} className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-gray-900">{listing.marketplace.name}</span>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${marca.classe}`}>
                        {marca.texto}
                      </span>
                      {listing.conta && (
                        <span className="font-mono text-xs text-gray-400" title="Conta do provedor">
                          {listing.conta}
                        </span>
                      )}
                      {listing.publishedPrice && (
                        <span className="text-gray-500">
                          no canal: {moeda(listing.publishedPrice, produto.currency)} · {listing.publishedStock}
                        </span>
                      )}
                      {listing.lastError && (
                        <span className="text-red-700" title={listing.lastError}>· {listing.lastError}</span>
                      )}
                    </div>
                  );
                })}

                <div className="ml-auto flex flex-wrap gap-2">
                  {publicaveis.map((canal) => {
                    const jaTem = produto.listings.find((l) => l.marketplace.id === canal.id);
                    // Com uma conta só não há o que escolher. Com mais de uma, a
                    // escolha é obrigatória, e a já usada pelo anúncio vem
                    // pré-selecionada para não trocar de conta sem querer.
                    const varias = canal.contas.length > 1;
                    const jaUsada = canal.contas.find((c) => c.externalAccountId === jaTem?.conta);
                    const escolhida = conta[canal.id] ?? jaUsada?.id ?? "";
                    return (
                      <div key={canal.id} className="flex items-center gap-1.5">
                        {varias && (
                          <select
                            value={escolhida}
                            onChange={(evento) => setConta({ ...conta, [canal.id]: evento.target.value })}
                            disabled={!!jaUsada}
                            title={jaUsada
                              ? "Já publicado nesta conta; despublique antes de trocar"
                              : `Conta de ${canal.name}`}
                            className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 font-mono text-xs disabled:bg-gray-100 disabled:text-gray-500"
                          >
                            <option value="">Conta…</option>
                            {canal.contas.map((c) => (
                              <option key={c.id} value={c.id}>{c.externalAccountId}</option>
                            ))}
                          </select>
                        )}
                        <button
                          onClick={() => rodar(
                            () => publicar(produto.id, [canal.id], escolhida ? { [canal.id]: escolhida } : {}),
                            (r: { canais: string[]; sincronizados: number }) => r.sincronizados
                              ? `${produto.sku} publicado em ${r.canais.join(", ")}.`
                              : `Publicação de ${produto.sku} enfileirada para ${r.canais.join(", ")}; o agendador conclui.`)}
                          disabled={pendente || !produto.active || (varias && !escolhida)}
                          title={!produto.active ? "Produto inativo não pode ser publicado"
                            : varias && !escolhida ? "Escolha a conta primeiro" : undefined}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-700 disabled:opacity-40"
                        >
                          <Send size={14} />
                          {jaTem ? "Republicar" : "Publicar"} em {canal.name}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {produtos.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center text-gray-500">
          Nenhum produto no catálogo.
        </div>
      )}
    </div>
  );
}
