"use server";
import { prisma } from "@/lib/prisma";
import { currentActor } from "@/lib/current-actor";
import { objectInput, OrderError, textInput } from "@/lib/domain/order-input";
import {
  deleteMarketplace as excluir, listMarketplaces, saveMarketplaceSettings,
  upsertMarketplace as gravar,
} from "@/lib/services/marketplaces";
import { revalidatePath } from "next/cache";

/**
 * Ações da tela de Marketplaces.
 *
 * A regra de negócio mora no serviço (`lib/services/marketplaces.ts`), que é
 * onde a auditoria, a transação e a checagem de papel acontecem. Aqui só se
 * resolve o ator, se chama o serviço e se revalida a rota -- foi assim que a
 * tela de Organizações ficou, e é o que deixa o comportamento testável sem
 * subir o Next.
 */

export async function getMarketplaces() {
  const actor = await currentActor();
  return listMarketplaces(prisma, actor);
}

/**
 * Grava identidade e configuração numa chamada, na ordem em que dependem uma
 * da outra: a configuração precisa do canal existindo.
 *
 * Não é uma transação só. Se a segunda parte falhar, sobra um canal com
 * pendência -- que a tela mostra e o administrador corrige. O contrário
 * (transação única) exigiria o serviço inteiro dentro de uma, e um erro de
 * digitação num campo desfaria a criação do canal, que é pior de entender.
 */
export async function salvarCanal(input: unknown) {
  const actor = await currentActor();
  const data = objectInput(input);
  const { id } = await gravar(prisma, actor, {
    id: data.id, name: data.name, provider: data.provider, active: data.active,
  });

  let falta: string[] = [];
  if (data.config !== undefined && data.config !== null) {
    const resultado = await saveMarketplaceSettings(prisma, actor, id, data.config);
    falta = resultado.falta;
  }

  revalidatePath("/marketplaces");
  revalidatePath("/integrations");
  return { id, falta };
}

export async function excluirCanal(id: unknown) {
  const actor = await currentActor();
  const canal = textInput(id, "Canal");
  await excluir(prisma, actor, canal);
  revalidatePath("/marketplaces");
  revalidatePath("/integrations");
}

/// Mantidos com os nomes antigos porque outras telas os importam.
export async function upsertMarketplace(input: unknown) {
  const data = objectInput(input);
  if (data.provider === undefined) {
    throw new OrderError("Escolha o provedor do canal na lista.");
  }
  return salvarCanal(input);
}

export async function deleteMarketplace(id: string) {
  return excluirCanal(id);
}
