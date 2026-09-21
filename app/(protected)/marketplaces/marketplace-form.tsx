"use client";

import { useMemo, useState } from "react";
import { Plus, Pencil, Loader2 } from "lucide-react";
import type { MarketplaceProvider } from "@prisma/client";
import { camposDoProvedor, PROVEDORES } from "@/lib/domain/marketplace-config";
import { salvarCanal } from "./actions";
import type { MarketplaceRow } from "./types";

/**
 * Cadastro de um canal: provedor, nome e a configuração DELE.
 *
 * O provedor virou lista suspensa porque era texto livre, e o sistema derivava
 * a integração desse texto: quem digitasse "mercadolivre_2" ficava com um
 * canal que nunca se conectava, sem erro em lugar nenhum.
 *
 * Os campos da configuração não estão escritos aqui: vêm de
 * `camposDoProvedor`, o mesmo catálogo que o servidor usa para validar. Se
 * estivessem nos dois lugares, um dia a tela pediria um campo que o servidor
 * recusa -- ou aceitaria um que ninguém lê.
 *
 * Segredo nunca volta do servidor. Para um campo secreto já preenchido, o
 * formulário mostra que existe e trata o branco como "manter"; apagar exige
 * marcar a caixa, porque limpar sem querer derrubaria a integração.
 */
export function MarketplaceForm({ defaultValues }: { defaultValues?: MarketplaceRow }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const [provider, setProvider] = useState<MarketplaceProvider | "">(
    defaultValues?.provider ?? "");
  const [name, setName] = useState(defaultValues?.name ?? "");
  const [active, setActive] = useState(defaultValues?.active ?? true);
  const [valores, setValores] = useState<Record<string, string>>({});
  const [apagar, setApagar] = useState<Record<string, boolean>>({});

  const campos = useMemo(
    () => (provider ? camposDoProvedor(provider) : []), [provider]);
  const preenchidas = useMemo(
    () => new Set(defaultValues?.preenchidas ?? []), [defaultValues]);

  const escolherProvedor = (valor: string) => {
    const novo = valor as MarketplaceProvider | "";
    setProvider(novo);
    // Sugere o nome só enquanto ninguém digitou o seu: um canal pode se chamar
    // "Mercado Livre Matriz", e sobrescrever isso apagaria o que a pessoa
    // escreveu.
    if (!name.trim() && novo) {
      setName(PROVEDORES.find((p) => p.provider === novo)?.nomeSugerido ?? "");
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!provider) { setErro("Escolha o provedor."); return; }
    setIsPending(true);
    setErro(null);
    try {
      const config: Record<string, string> = {};
      for (const campo of campos) {
        const digitado = valores[campo.chave] ?? "";
        if (campo.tipo === "segredo") {
          // Em branco = manter o que está gravado. Só vai para o servidor o
          // que foi digitado, ou o pedido explícito de apagar.
          if (apagar[campo.chave]) config[campo.chave] = "";
          else if (digitado) config[campo.chave] = digitado;
          continue;
        }
        if (campo.tipo === "booleano") {
          config[campo.chave] = digitado === "true" ? "true" : "false";
          continue;
        }
        // Campo visível e não secreto vai sempre: é assim que limpar funciona.
        config[campo.chave] = digitado;
      }
      await salvarCanal({ id: defaultValues?.id, name, provider, active, config });
      setIsOpen(false);
      window.location.reload();
    } catch (err) {
      // A mensagem do serviço nomeia o campo ("App Secret é obrigatório",
      // "Mercado Livre já está cadastrado no canal X"). Trocar por um texto
      // genérico esconderia a única informação útil.
      setErro(err instanceof Error ? err.message : "Erro ao salvar o canal");
    } finally {
      setIsPending(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className={defaultValues
          ? "p-2 hover:bg-gray-100 rounded-full"
          : "flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"}
      >
        {defaultValues ? <Pencil size={18} /> : <><Plus size={18} /> Novo Marketplace</>}
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b">
              <h2 className="text-xl font-semibold">
                {defaultValues ? "Editar Marketplace" : "Cadastrar Marketplace"}
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                A configuração é desta organização: cada uma usa as credenciais dela.
              </p>
            </div>

            <form onSubmit={onSubmit} className="p-6 space-y-4">
              {erro && (
                <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{erro}</p>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Provedor</label>
                <select
                  value={provider}
                  onChange={(e) => escolherProvedor(e.target.value)}
                  required
                  className="w-full px-3 py-2 border rounded-lg bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="">Selecione…</option>
                  {PROVEDORES.map((p) => (
                    <option key={p.provider} value={p.provider}>{p.rotulo}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Define a integração do canal. O código usado em URL e log deriva dele.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nome do canal</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="Ex: Mercado Livre"
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                  id="active"
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded"
                />
                <label htmlFor="active" className="text-sm font-medium text-gray-700">
                  Marketplace ativo
                </label>
              </div>

              {campos.length > 0 && (
                <div className="pt-2 border-t space-y-4">
                  <h3 className="text-sm font-semibold text-gray-900">
                    Configuração da integração
                  </h3>
                  {campos.map((campo) => {
                    const jaTem = preenchidas.has(campo.chave);
                    const valor = valores[campo.chave] ?? "";
                    return (
                      <div key={campo.chave}>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          {campo.rotulo}
                          {campo.obrigatorio
                            ? <span className="text-red-600"> *</span>
                            : <span className="text-gray-400"> (opcional)</span>}
                          {campo.tipo === "segredo" && jaTem && (
                            <span className="ml-2 text-xs font-normal text-green-700">configurado</span>
                          )}
                        </label>

                        {campo.tipo === "booleano" ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={valor === "true"}
                              onChange={(e) => setValores((v) => ({
                                ...v, [campo.chave]: e.target.checked ? "true" : "false",
                              }))}
                              className="w-4 h-4 text-blue-600 border-gray-300 rounded"
                            />
                            <span className="text-sm text-gray-600">Ligado</span>
                          </div>
                        ) : (
                          <input
                            type={campo.tipo === "segredo" ? "password" : "text"}
                            value={valor}
                            onChange={(e) => setValores((v) => ({ ...v, [campo.chave]: e.target.value }))}
                            required={campo.obrigatorio && !(campo.tipo === "segredo" && jaTem)}
                            disabled={apagar[campo.chave]}
                            autoComplete="off"
                            placeholder={campo.tipo === "segredo" && jaTem
                              ? "Deixe em branco para manter"
                              : campo.padrao ?? ""}
                            className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-gray-100"
                          />
                        )}

                        {campo.tipo === "segredo" && jaTem && (
                          <label className="mt-1 flex items-center gap-2 text-xs text-gray-600">
                            <input
                              type="checkbox"
                              checked={apagar[campo.chave] ?? false}
                              onChange={(e) => setApagar((a) => ({ ...a, [campo.chave]: e.target.checked }))}
                              className="w-3 h-3"
                            />
                            Apagar este valor
                          </label>
                        )}

                        <p className="text-xs text-gray-500 mt-1">{campo.ajuda}</p>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="flex-1 px-4 py-2 border rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
                >
                  {isPending && <Loader2 className="animate-spin" size={18} />}
                  {defaultValues ? "Salvar alterações" : "Criar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
