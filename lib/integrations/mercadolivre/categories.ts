import "server-only";
import { objectInput, OrderError, textInput } from "../../domain/order-input";
import { ProviderAuthError, ProviderTransientError } from "./client";

/**
 * Árvore de categorias do Mercado Livre.
 *
 * `/sites/{site}/categories/all` devolve a árvore inteira numa resposta só —
 * 12.233 categorias e ~29 MB no MLB, medidos. Isso é o que torna a cópia
 * viável: a alternativa seria uma requisição por nó, milhares delas.
 *
 * A resposta é um objeto indexado pelo id da categoria, e cada entrada traz
 * `path_from_root`, que já é a linhagem completa. Daí saem pai, profundidade e
 * caminho legível sem precisar montar a árvore.
 */

/// O site define a árvore: MLB é Brasil, MLA é Argentina. Vem do canal, não
/// daqui, mas o padrão cobre o caso que existe hoje.
export const SITE_PADRAO = "MLB";

export interface CategoriaCrua {
  externalId: string;
  name: string;
  parentExternalId: string | null;
  path: string;
  depth: number;
  listingAllowed: boolean;
}

function base() {
  const raw = process.env.MERCADO_LIVRE_API_URL ?? "https://api.mercadolibre.com";
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new OrderError("MERCADO_LIVRE_API_URL inválida.");
  return url.origin;
}

/**
 * Baixa e normaliza a árvore.
 *
 * Devolve a lista já pronta para gravar, com `leaf` decidido por quem é pai de
 * quem — a entrada não diz "sou folha", mas `path_from_root` de todo mundo diz
 * quem tem filhos.
 */
export async function fetchMercadoLivreCategories(
  token: string, site = SITE_PADRAO, fetcher: typeof fetch = fetch,
): Promise<(CategoriaCrua & { leaf: boolean })[]> {
  if (!/^[A-Z]{3}$/.test(site)) throw new OrderError("Site do Mercado Livre inválido.");
  const response = await fetcher(`${base()}/sites/${site}/categories/all`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    // Bem mais que os 2,4 s medidos: a resposta é grande e a rede varia.
    signal: AbortSignal.timeout(60000),
  });
  if (response.status === 401 || response.status === 403) throw new ProviderAuthError("ML_UNAUTHORIZED");
  if (response.status === 429 || response.status >= 500) throw new ProviderTransientError("ML_UNAVAILABLE");
  if (!response.ok) throw new OrderError("Falha ao consultar as categorias do Mercado Livre.");

  const corpo = objectInput(await response.json());
  const entradas = Object.values(corpo);
  if (!entradas.length) throw new OrderError("O Mercado Livre devolveu a árvore de categorias vazia.");

  const pais = new Set<string>();
  const cruas: CategoriaCrua[] = [];
  for (const entrada of entradas) {
    const item = objectInput(entrada);
    const externalId = textInput(item.id, "Categoria", 40);
    const linhagem = Array.isArray(item.path_from_root) ? item.path_from_root.map(objectInput) : [];
    if (!linhagem.length) continue;

    // Todo mundo menos o último elo é pai de alguém.
    for (let i = 0; i < linhagem.length - 1; i++) {
      pais.add(textInput(linhagem[i].id, "Categoria ancestral", 40));
    }

    const nomes = linhagem.map((elo) => textInput(elo.name, "Nome da categoria", 200));
    const settings = item.settings ? objectInput(item.settings) : {};
    cruas.push({
      externalId,
      name: nomes[nomes.length - 1],
      parentExternalId: linhagem.length > 1
        ? textInput(linhagem[linhagem.length - 2].id, "Categoria pai", 40) : null,
      path: nomes.join(" > "),
      depth: linhagem.length - 1,
      // Ausente é permitido: só o `false` explícito fecha a categoria.
      listingAllowed: settings.listing_allowed !== false,
    });
  }
  if (!cruas.length) throw new OrderError("Nenhuma categoria utilizável na resposta do Mercado Livre.");
  return cruas.map((c) => ({ ...c, leaf: !pais.has(c.externalId) }));
}
