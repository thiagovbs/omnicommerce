"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, Save } from "lucide-react";
import { atributosDaCategoria, salvarAtributos } from "./actions";

interface Definicao {
  id: string;
  name: string;
  tipo: "texto" | "lista" | "numero" | "numero_com_unidade";
  obrigatorio: boolean;
  valores: { id: string; name: string }[];
  maxLength: number | null;
  unidades: string[];
  hint: string | null;
  /// Valor que a publicação usaria sozinha, vindo do produto. Aparece como
  /// sugestão para não parecer que o campo está faltando.
  automatico: string | null;
}

/**
 * Atributos que a categoria do provedor exige.
 *
 * Nenhum é obrigatório AQUI de propósito: o cadastro não deve travar porque o
 * Mercado Livre quer a homologação da Anatel. Faltar um atributo exigido não
 * impede salvar; impede publicar, e aí a mensagem nomeia o que falta — e esta
 * tela avisa antes, para a descoberta não acontecer no botão de publicar.
 *
 * A definição vem do provedor a cada abertura, e não de uma cópia nossa: são
 * 12 mil categorias com atributos próprios, e guardar todas seria copiar um
 * catálogo inteiro para usar um punhado de linhas.
 */
export function AttributeFields({ productId, marketplaceId }: { productId: string; marketplaceId: string }) {
  const [definicoes, setDefinicoes] = useState<Definicao[] | null>(null);
  const [valores, setValores] = useState<Record<string, string>>({});
  const [estado, setEstado] = useState<string>("");
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState<{ erro: boolean; texto: string } | null>(null);
  const [enviados, setEnviados] = useState<unknown>(null);
  const [enviadosEm, setEnviadosEm] = useState<string | null>(null);

  // Só na montagem: o componente é remontado pelo `key` quando o canal muda,
  // o que evita um efeito reagindo a mudança de estado.
  useEffect(() => {
    void (async () => {
      const resultado = await atributosDaCategoria(productId, marketplaceId);
      if (!resultado.ok) { setAviso({ erro: true, texto: resultado.erro }); setDefinicoes([]); return; }
      setEstado(resultado.estado);
      const defs = (resultado.definicoes ?? []) as Definicao[];
      setDefinicoes(defs);
      // O que já está gravado vira o valor inicial do campo.
      const iniciais: Record<string, string> = {};
      for (const [id, v] of Object.entries(resultado.valores ?? {})) {
        const valor = v as { valueId?: string; valueName?: string };
        iniciais[id] = valor.valueId ?? valor.valueName ?? "";
      }
      setValores(iniciais);
      setEnviados(resultado.enviados ?? null);
      setEnviadosEm(resultado.enviadosEm ?? null);
    })();
  }, [productId, marketplaceId]);

  if (definicoes === null) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-gray-400">
        <Loader2 size={14} className="animate-spin" /> Consultando o que a categoria exige…
      </div>
    );
  }

  if (estado === "sem-categoria") {
    return (
      <p className="py-3 text-sm text-gray-500">
        Escolha a categoria acima para ver o que ela exige.
      </p>
    );
  }
  if (estado === "sem-atributos" || estado === "sem-anuncio") return null;

  const faltando = definicoes.filter(
    (d) => d.obrigatorio && !valores[d.id]?.trim() && !d.automatico);

  return (
    <div className="space-y-3 border-t border-gray-200 pt-4">
      <div>
        <h3 className="text-sm font-medium text-gray-900">Atributos da categoria</h3>
        <p className="text-xs text-gray-500">
          Nenhum é obrigatório aqui — mas os marcados com{" "}
          <span className="text-red-600">*</span> o Mercado Livre exige para publicar.
        </p>
      </div>

      {aviso && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${
          aviso.erro ? "border-red-200 bg-red-50 text-red-800" : "border-green-200 bg-green-50 text-green-800"
        }`}>
          {aviso.texto}
        </div>
      )}

      {faltando.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            Publicar vai falhar sem: {faltando.map((d) => d.name).join(", ")}.
          </span>
        </div>
      )}

      {!definicoes.length && (
        <p className="text-sm text-gray-500">Esta categoria não exige atributos além dos do produto.</p>
      )}

      <div className="grid grid-cols-2 gap-3">
        {definicoes.map((d) => (
          <div key={d.id}>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              {d.name}
              {d.obrigatorio && <span className="text-red-600"> *</span>}
              <span className="ml-1 font-mono font-normal text-gray-400">{d.id}</span>
            </label>

            {d.tipo === "lista" ? (
              <select
                value={valores[d.id] ?? ""}
                onChange={(e) => setValores({ ...valores, [d.id]: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">
                  {d.automatico ? `Automático: ${d.automatico}` : "Não informado"}
                </option>
                {d.valores.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            ) : (
              <>
                <input
                  value={valores[d.id] ?? ""}
                  onChange={(e) => setValores({ ...valores, [d.id]: e.target.value })}
                  inputMode={d.tipo === "numero" ? "numeric" : undefined}
                  maxLength={d.maxLength ?? undefined}
                  // Sugestões do provedor sem fechar a lista: em `texto` ele
                  // aceita qualquer valor, e travar nas sugestões impediria
                  // cadastrar uma marca que ele ainda não conhece.
                  list={d.valores.length ? `sugestoes-${d.id}` : undefined}
                  placeholder={d.automatico
                    ? `Automático: ${d.automatico}`
                    : d.unidades.length ? `ex.: 1 ${d.unidades[0]}` : "Não informado"}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                {d.valores.length > 0 && (
                  <datalist id={`sugestoes-${d.id}`}>
                    {d.valores.map((v) => <option key={v.id} value={v.name} />)}
                  </datalist>
                )}
              </>
            )}
            {d.hint && <p className="mt-0.5 text-[11px] text-gray-400">{d.hint}</p>}
          </div>
        ))}
      </div>

      {definicoes.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button" disabled={salvando}
            onClick={async () => {
              setSalvando(true);
              setAviso(null);
              const resultado = await salvarAtributos(productId, marketplaceId, valores);
              setSalvando(false);
              setAviso(resultado.ok
                ? { erro: false, texto: `${resultado.gravados} atributo(s) gravado(s).` }
                : { erro: true, texto: resultado.erro });
            }}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-700 disabled:opacity-50"
          >
            {salvando ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Salvar atributos
          </button>
        </div>
      )}

      {enviados !== null && (
        <details className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-gray-600">
            O que foi enviado ao provedor
            {enviadosEm && ` em ${new Date(enviadosEm).toLocaleString("pt-BR")}`}
          </summary>
          {/* Legível de propósito: quando o provedor recusa, a diferença entre
              o preenchido e o enviado é o que costuma explicar o motivo. */}
          <pre className="mt-2 overflow-x-auto text-[11px] leading-relaxed text-gray-700">
            {JSON.stringify(enviados, null, 2)}
          </pre>
        </details>
      )}

      {!faltando.length && definicoes.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-green-700">
          <Check size={13} /> Todos os atributos exigidos têm valor.
        </p>
      )}
    </div>
  );
}
