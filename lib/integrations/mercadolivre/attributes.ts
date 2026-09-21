import "server-only";
import { objectInput, OrderError, textInput } from "../../domain/order-input";
import { API_ORIGIN, ProviderTransientError } from "./client";

/**
 * Atributos que uma categoria do Mercado Livre exige.
 *
 * O endpoint é PÚBLICO — medido: responde 200 sem Authorization. Isso importa
 * porque a tela precisa dizer "esta categoria exige tais campos" mesmo com a
 * credencial da conta vencida, e o token do ML vale só 6 horas nesta aplicação.
 *
 * O que a resposta real ensinou, medindo cinco categorias:
 *
 * - `string` com lista de valores é SUGESTÃO, não lista fechada: BRAND traz 75
 *   valores e ainda aceita texto livre até 255. `list` é fechada e exige o id
 *   do valor. São dois campos diferentes na tela.
 * - `boolean` também vem com dois valores identificados, então é tratado como
 *   lista fechada de dois itens.
 * - `GTIN` é `required` em livros e `conditional_required` em mouse pads: onde
 *   é obrigatório de verdade não existe o escape de "não tenho código".
 */

export type TipoDeAtributo = "texto" | "lista" | "numero" | "numero_com_unidade";

export interface DefinicaoDeAtributo {
  id: string;
  name: string;
  tipo: TipoDeAtributo;
  /// Exigido sempre, ou exigido dependendo de outros campos.
  obrigatorio: boolean;
  /// Valores do provedor. Em `lista` são as únicas opções; em `texto` são
  /// sugestões, e qualquer texto serve.
  valores: { id: string; name: string }[];
  /// Só em `texto`: limite do provedor.
  maxLength: number | null;
  /// Só em `numero_com_unidade`: unidades aceitas.
  unidades: string[];
  /// Dica do provedor, quando ele dá uma.
  hint: string | null;
}

/// Preenchidos por nós a partir do produto ou da regra do provedor. Continuam
/// aparecendo na tela, porque um valor explícito deve poder vencer o
/// automático -- menos o motivo de GTIN vazio, que é consequência e não escolha.
export const ATRIBUTOS_AUTOMATICOS = ["BRAND", "MODEL", "GTIN"];
export const ATRIBUTO_DERIVADO = "EMPTY_GTIN_REASON";

function tipoDe(valueType: unknown, unidades: unknown[]): TipoDeAtributo {
  const tipo = String(valueType ?? "string");
  if (tipo === "list" || tipo === "boolean") return "lista";
  if (tipo === "number_unit" || unidades.length) return "numero_com_unidade";
  if (tipo === "number") return "numero";
  return "texto";
}

export async function fetchCategoryAttributes(
  categoryId: string, fetcher: typeof fetch = fetch,
): Promise<DefinicaoDeAtributo[]> {
  const id = textInput(categoryId, "Categoria", 40);
  if (!/^[A-Z]{3}\d{1,20}$/.test(id)) throw new OrderError("Categoria inválida.");

  const response = await fetcher(`${API_ORIGIN}/categories/${id}/attributes`, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) throw new OrderError("Categoria não encontrada no Mercado Livre.");
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("ML_UNAVAILABLE");
  if (!response.ok) throw new OrderError("Não foi possível ler os atributos da categoria.");

  const corpo: unknown = await response.json();
  if (!Array.isArray(corpo)) throw new OrderError("Atributos da categoria em formato inesperado.");

  const definicoes: DefinicaoDeAtributo[] = [];
  for (const cru of corpo) {
    const atributo = objectInput(cru);
    const tags = atributo.tags ? objectInput(atributo.tags) : {};
    // Só o que a categoria exige. Os outros 80 e tantos atributos opcionais
    // transformariam o formulário num questionário.
    if (!tags.required && !tags.conditional_required) continue;
    if (atributo.id === ATRIBUTO_DERIVADO) continue;

    const unidades = Array.isArray(atributo.allowed_units)
      ? atributo.allowed_units.map((u) => textInput(objectInput(u).id, "Unidade", 20)) : [];
    definicoes.push({
      id: textInput(atributo.id, "Atributo", 60),
      name: typeof atributo.name === "string" && atributo.name ? atributo.name : String(atributo.id),
      tipo: tipoDe(atributo.value_type, unidades),
      obrigatorio: tags.required === true,
      valores: (Array.isArray(atributo.values) ? atributo.values : []).map((v) => {
        const valor = objectInput(v);
        return {
          id: textInput(valor.id, "Valor do atributo", 60),
          name: typeof valor.name === "string" ? valor.name : String(valor.id),
        };
      }),
      maxLength: typeof atributo.value_max_length === "number" ? atributo.value_max_length : null,
      unidades,
      hint: typeof atributo.hint === "string" && atributo.hint ? atributo.hint : null,
    });
  }
  return definicoes;
}
