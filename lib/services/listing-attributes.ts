import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";
import { providerDoCanal } from "../domain/marketplace-provider";
import { objectInput, OrderError, textInput } from "../domain/order-input";
import {
  ATRIBUTO_DERIVADO, DefinicaoDeAtributo, fetchCategoryAttributes,
} from "../integrations/mercadolivre/attributes";
import { assertOrgAdmin } from "./access";
import { UserActor } from "./actor";
import { serializable } from "./transactions";

/**
 * Atributos exigidos pela categoria do provedor, preenchidos por quem cadastra.
 *
 * O catálogo é genérico de propósito — título, preço, estoque, marca — e cada
 * categoria do Mercado Livre exige coisas próprias: GENDER e SIZE em vestuário,
 * homologação da Anatel em celulares. Enfileirar todas essas colunas no produto
 * seria impossível: são 12 mil categorias.
 *
 * Então os valores moram no anúncio, em JSON, e a DEFINIÇÃO vem do provedor na
 * hora de montar o formulário. O endpoint de atributos é público, o que permite
 * perguntar "o que esta categoria exige?" mesmo com a credencial vencida.
 */

/// Um valor preenchido, na forma que o provedor espera.
export interface ValorDeAtributo {
  /// Lista fechada: o provedor exige o identificador do valor.
  valueId?: string;
  /// Texto livre, número ou número com unidade.
  valueName?: string;
}

export type AtributosDoAnuncio = Record<string, ValorDeAtributo>;

/**
 * Forma canônica dos atributos, para comparar e para a impressão.
 *
 * JSONB **não preserva a ordem das chaves**: o mapa volta do Postgres
 * reordenado. Comparar `JSON.stringify` de dois mapas fazia salvar sem mudar
 * nada parecer mudança, e cada clique em Salvar marcaria o anúncio para
 * republicar. Ordenar pelo identificador remove a ambiguidade.
 */
export function atributosCanonicos(valores: AtributosDoAnuncio) {
  return Object.keys(valores).sort().map((id) => [
    id, valores[id].valueId ?? null, valores[id].valueName ?? null,
  ]);
}

/// Lê o JSON gravado sem confiar nele: é dado de banco, e uma migração ou
/// escrita antiga pode ter deixado qualquer coisa ali.
export function lerAtributos(valor: Prisma.JsonValue | null | undefined): AtributosDoAnuncio {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return {};
  const saida: AtributosDoAnuncio = {};
  for (const [id, cru] of Object.entries(valor)) {
    if (!cru || typeof cru !== "object" || Array.isArray(cru)) continue;
    const item = cru as Record<string, unknown>;
    const valueId = typeof item.valueId === "string" && item.valueId ? item.valueId : undefined;
    const valueName = typeof item.valueName === "string" && item.valueName ? item.valueName : undefined;
    if (valueId || valueName) saida[id] = { ...(valueId ? { valueId } : {}), ...(valueName ? { valueName } : {}) };
  }
  return saida;
}

/// Só o Mercado Livre tem categorias com atributos exigidos. Derivado do mesmo
/// lugar que decide quem tem árvore, para não haver duas listas discordando.
export function buscadorDeAtributos(code: string) {
  return providerDoCanal(code) === "MERCADO_LIVRE" ? fetchCategoryAttributes : null;
}

/**
 * O que a categoria do anúncio exige, junto do que já está preenchido.
 *
 * Devolve também o valor que seria usado automaticamente, para a tela mostrar
 * de onde vem cada coisa em vez de parecer que o campo está vazio.
 */
export async function listListingAttributes(
  db: PrismaClient, actor: UserActor, productId: string, marketplaceId: string,
  buscar = fetchCategoryAttributes,
) {
  const produto = textInput(productId, "Produto");
  const canal = textInput(marketplaceId, "Canal");

  const listing = await db.listing.findFirst({
    where: {
      productId: produto, marketplaceId: canal,
      product: { organizationId: actor.organizationId },
    },
    select: {
      categoryExternalId: true, attributes: true, publishedAttributes: true, lastPublishedAt: true,
      product: { select: { brand: true, sku: true } },
      marketplace: { select: { code: true } },
    },
  });
  if (!listing) return { estado: "sem-anuncio" as const, definicoes: [], valores: {} as AtributosDoAnuncio, enviados: null, enviadosEm: null };
  if (!buscadorDeAtributos(listing.marketplace.code)) {
    return { estado: "sem-atributos" as const, definicoes: [], valores: {} as AtributosDoAnuncio, enviados: null, enviadosEm: null };
  }
  if (!listing.categoryExternalId) {
    return { estado: "sem-categoria" as const, definicoes: [], valores: {} as AtributosDoAnuncio, enviados: null, enviadosEm: null };
  }

  const definicoes = await buscar(listing.categoryExternalId);
  // De onde sai o valor quando ninguém preenche. A tela mostra isso como
  // sugestão, e não como campo vazio, porque publicar já funciona sem ele.
  const automaticos: Record<string, string> = {
    BRAND: listing.product.brand,
    MODEL: listing.product.sku,
  };
  return {
    estado: "ok" as const,
    categoria: listing.categoryExternalId,
    definicoes: definicoes.map((d) => ({ ...d, automatico: automaticos[d.id] ?? null })),
    valores: lerAtributos(listing.attributes),
    // O que foi de fato enviado na última publicação, legível. É a diferença
    // entre isto e o preenchido que explica a maioria das recusas.
    enviados: listing.publishedAttributes ?? null,
    enviadosEm: listing.lastPublishedAt?.toISOString() ?? null,
  };
}

/**
 * Grava os atributos preenchidos.
 *
 * Valida contra a definição do provedor: identificador desconhecido, valor
 * fora da lista fechada ou texto acima do limite são recusados aqui, e não na
 * publicação — onde o erro chegaria longe de quem digitou.
 *
 * Nenhum campo é obrigatório nesta tela. Faltar um atributo exigido não
 * impede salvar; impede publicar, e aí a mensagem nomeia o que falta.
 */
export async function setListingAttributes(
  db: PrismaClient, actor: UserActor, productId: string, marketplaceId: string,
  entrada: unknown, buscar = fetchCategoryAttributes,
) {
  const produto = textInput(productId, "Produto");
  const canal = textInput(marketplaceId, "Canal");
  const bruto = objectInput(entrada);

  const listing = await db.listing.findFirst({
    where: {
      productId: produto, marketplaceId: canal,
      product: { organizationId: actor.organizationId },
    },
    select: { id: true, categoryExternalId: true, attributes: true, status: true,
              marketplace: { select: { code: true, name: true } },
              product: { select: { sku: true } } },
  });
  if (!listing) throw new OrderError("Escolha a categoria do canal antes de preencher os atributos.");
  if (!listing.categoryExternalId) throw new OrderError("Escolha a categoria antes de preencher os atributos.");
  if (!buscadorDeAtributos(listing.marketplace.code)) {
    throw new OrderError("Este canal não tem atributos de categoria.");
  }

  const definicoes = await buscar(listing.categoryExternalId);
  const porId = new Map(definicoes.map((d) => [d.id, d]));
  const valores: AtributosDoAnuncio = {};

  for (const [id, cru] of Object.entries(bruto)) {
    if (id === ATRIBUTO_DERIVADO) continue;
    const definicao = porId.get(id);
    // Atributo que a categoria não pede não é gravado: ele viraria lixo que
    // acompanharia o anúncio mesmo depois de trocar de categoria.
    if (!definicao) continue;
    if (cru === null || cru === undefined || cru === "") continue;

    const texto = textInput(cru, definicao.name, 1000);
    if (definicao.tipo === "lista") {
      const opcao = definicao.valores.find((v) => v.id === texto);
      if (!opcao) throw new OrderError(`Valor inválido para ${definicao.name}.`);
      valores[id] = { valueId: opcao.id };
      continue;
    }
    if (definicao.maxLength && texto.length > definicao.maxLength) {
      throw new OrderError(`${definicao.name} aceita até ${definicao.maxLength} caracteres.`);
    }
    if (definicao.tipo === "numero" && !/^\d+([.,]\d+)?$/.test(texto)) {
      throw new OrderError(`${definicao.name} deve ser um número.`);
    }
    valores[id] = { valueName: texto };
  }

  const anteriores = lerAtributos(listing.attributes);
  const mudou = JSON.stringify(atributosCanonicos(anteriores))
    !== JSON.stringify(atributosCanonicos(valores));

  return serializable(db, async (tx) => {
    await assertOrgAdmin(tx, actor);
    await tx.listing.update({
      where: { id: listing.id },
      data: {
        attributes: valores as Prisma.InputJsonValue,
        // Atributo mudado é mudança publicável. A impressão já cobre isso, mas
        // sem ligar a marca o trabalhador só olharia o anúncio na varredura
        // seguinte -- e ele só varre o que está marcado.
        ...(mudou && listing.status === "PUBLISHED"
          ? { needsSync: true, availableAt: new Date(), attempts: 0 }
          : {}),
      },
    });
    if (mudou) {
      await tx.auditLog.create({ data: {
        action: "UPDATE", entity: "PRODUCT", entityId: produto,
        organizationId: actor.organizationId, userId: actor.userId,
        details: "Atributos de " + listing.product.sku + " em " + listing.marketplace.name
          + " atualizados: " + (Object.keys(valores).join(", ") || "nenhum") + ".",
        newData: { canal: listing.marketplace.name, atributos: Object.keys(valores) },
      } });
    }
    return { gravados: Object.keys(valores).length, mudou };
  });
}

/// Os exigidos que continuam sem valor, contando o que derivamos do produto.
/// É o que a tela usa para avisar antes de tentar publicar.
export function faltando(
  definicoes: (DefinicaoDeAtributo & { automatico?: string | null })[],
  valores: AtributosDoAnuncio,
) {
  return definicoes
    .filter((d) => d.obrigatorio && !valores[d.id]?.valueId && !valores[d.id]?.valueName && !d.automatico)
    .map((d) => d.name);
}
