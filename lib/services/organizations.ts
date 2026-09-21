import "server-only";
import { PrismaClient } from "@prisma/client";
import { objectInput, OrderError, textInput } from "../domain/order-input";
import { OrganizationProfile, parseOrganizationProfile } from "../domain/organization-input";
import { isPlatformAdmin } from "../domain/roles";
import { assertOrganizationAccess, assertOrgAdmin } from "./access";
import { UserActor } from "./actor";
import { serializable } from "./transactions";

/// Os campos cadastrais, na ordem em que a tela os mostra. Serve para a
/// auditoria registrar só o que mudou, sem listar o que ficou igual.
const CAMPOS_DO_PERFIL = [
  "legalName", "taxId", "email", "phone",
  "zipCode", "street", "number", "complement", "district", "city", "state",
] as const;

/**
 * Cria ou atualiza uma organização, com os dados cadastrais dela.
 *
 * Criar continua sendo só do operador da plataforma. Editar é de quem
 * administra a organização -- e `assertOrganizationAccess` é o que impede o
 * administrador de uma mexer na outra.
 */
export async function upsertOrganization(db: PrismaClient, actor: UserActor, input: unknown) {
  const data = objectInput(input);
  const id = data.id === undefined || data.id === null || data.id === "" ? null : textInput(data.id, "Organização");
  const name = textInput(data.name, "Nome");
  const perfil = parseOrganizationProfile(data);

  return serializable(db, async (tx) => {
    const actorRole = await assertOrgAdmin(tx, actor);
    // CNPJ repetido é quase sempre cadastro duplicado da mesma empresa, e
    // descobrir isso depois custa reconciliar dois tenants. A conferência é
    // aqui, e não num índice único, porque a coluna nasce vazia em todas as
    // organizações existentes e o índice recusaria a segunda vazia.
    if (perfil.taxId) {
      const mesmoCnpj = await tx.organization.findFirst({
        where: { taxId: perfil.taxId, ...(id ? { id: { not: id } } : {}) },
        select: { name: true },
      });
      if (mesmoCnpj) {
        throw new OrderError(`O CNPJ informado já é da organização ${mesmoCnpj.name}.`);
      }
    }

    if (!id) {
      if (!isPlatformAdmin(actorRole)) throw new OrderError("Apenas operadores da plataforma podem criar organizações.");
      const organization = await tx.organization.create({ data: { name, ...perfil } });
      await tx.auditLog.create({ data: {
        action: "CREATE", entity: "ORGANIZATION", entityId: organization.id, organizationId: organization.id,
        userId: actor.userId, details: `Organização ${name} criada.`, newData: { name },
      } });
      return { id: organization.id };
    }

    await assertOrganizationAccess(tx, actorRole, actor, id);
    const existing = await tx.organization.findUnique({
      where: { id },
      select: {
        name: true, legalName: true, taxId: true, email: true, phone: true,
        zipCode: true, street: true, number: true, complement: true, district: true,
        city: true, state: true,
      },
    });
    if (!existing) throw new OrderError("Organização não encontrada.");
    await tx.organization.update({ where: { id }, data: { name, ...perfil } });

    // Registra o que de fato mudou: auditoria que repete o cadastro inteiro a
    // cada salvamento esconde a alteração em vez de mostrá-la.
    const mudancas = CAMPOS_DO_PERFIL.filter(
      (campo) => existing[campo] !== perfil[campo as keyof OrganizationProfile]);
    const renomeou = existing.name !== name;
    const detalhes = renomeou
      ? `Organização renomeada de ${existing.name} para ${name}.`
      : `Cadastro de ${name} atualizado: ${mudancas.join(", ") || "nada"}.`;
    await tx.auditLog.create({ data: {
      action: "UPDATE", entity: "ORGANIZATION", entityId: id, organizationId: id, userId: actor.userId,
      details: detalhes,
      oldData: { name: existing.name, ...Object.fromEntries(mudancas.map((c) => [c, existing[c]])) },
      newData: { name, ...Object.fromEntries(mudancas.map((c) => [c, perfil[c as keyof OrganizationProfile]])) },
    } });
    return { id, mudancas: mudancas.length + (renomeou ? 1 : 0) };
  });
}

/**
 * Dados cadastrais de uma organização, para quem precisa deles fora da tela.
 *
 * Sem ator: quem chama é o trabalhador de publicação, que não tem usuário. A
 * organização vem do próprio anúncio que ele está publicando, então não há
 * escolha de tenant a fazer aqui -- e é por isso que esta função não decide
 * acesso nenhum.
 */
export async function organizationProfile(db: PrismaClient, organizationId: string) {
  const id = textInput(organizationId, "Organização");
  const organization = await db.organization.findUnique({
    where: { id },
    select: {
      name: true, legalName: true, taxId: true, email: true, phone: true,
      zipCode: true, street: true, number: true, complement: true, district: true,
      city: true, state: true,
    },
  });
  if (!organization) throw new OrderError("Organização não encontrada.");
  return organization;
}

export async function removeOrganization(db: PrismaClient, actor: UserActor, organizationId: unknown) {
  const id = textInput(organizationId, "Organização");
  return serializable(db, async (tx) => {
    const actorRole = await assertOrgAdmin(tx, actor);
    if (!isPlatformAdmin(actorRole)) throw new OrderError("Apenas operadores da plataforma podem excluir organizações.");
    if (id === actor.organizationId) throw new OrderError("Não é possível excluir a própria organização.");
    const organization = await tx.organization.findUnique({
      where: { id }, select: { name: true, _count: { select: { users: true, sales: true, marketplaces: true } } },
    });
    if (!organization) throw new OrderError("Organização não encontrada.");
    // Users, marketplaces and sales cascade on delete; require an empty organization instead of
    // destroying tenant data as a side effect of renaming a row.
    const { users, sales, marketplaces } = organization._count;
    if (users || sales || marketplaces) {
      throw new OrderError("Remova usuários, marketplaces e vendas antes de excluir a organização.");
    }
    await tx.organization.delete({ where: { id } });
    // Recorded under the actor's organization: rows of the removed one are cascade-deleted.
    await tx.auditLog.create({ data: {
      action: "DELETE", entity: "ORGANIZATION", entityId: id, organizationId: actor.organizationId,
      userId: actor.userId, details: `Organização ${organization.name} excluída.`, oldData: { name: organization.name },
    } });
  });
}
