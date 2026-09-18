import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { removeMember, upsertMember } from "../lib/services/members";
import { removeOrganization, upsertOrganization } from "../lib/services/organizations";

const db = new PrismaClient();
const password = "senha-de-teste-123";
const member = (email: string, extra: Record<string, unknown> = {}) => ({
  name: "Novo Membro", email, password, role: "OPERATOR", ...extra,
});

test("autorização de equipe e organizações em PostgreSQL", async (t) => {
  try {
    const orgA = await db.organization.create({ data: { name: "Access A" } });
    const orgB = await db.organization.create({ data: { name: "Access B" } });
    const orgC = await db.organization.create({ data: { name: "Access C" } });
    const empty = await db.organization.create({ data: { name: "Access Empty" } });

    const platform = await db.user.create({ data: { organizationId: orgA.id, name: "Plataforma", email: "platform@access.invalid", role: "PLATFORM_ADMIN" } });
    const adminA = await db.user.create({ data: { organizationId: orgA.id, name: "Admin A", email: "admin-a@access.invalid", role: "ADMIN" } });
    const operatorA = await db.user.create({ data: { organizationId: orgA.id, name: "Operador A", email: "operator-a@access.invalid", role: "OPERATOR" } });
    const adminB = await db.user.create({ data: { organizationId: orgB.id, name: "Admin B", email: "admin-b@access.invalid", role: "ADMIN" } });
    const operatorB = await db.user.create({ data: { organizationId: orgB.id, name: "Operador B", email: "operator-b@access.invalid", role: "OPERATOR" } });
    const onlyAdminC = await db.user.create({ data: { organizationId: orgC.id, name: "Admin C", email: "admin-c@access.invalid", role: "ADMIN" } });

    const platformActor = { userId: platform.id, organizationId: orgA.id };
    const actorA = { userId: adminA.id, organizationId: orgA.id };
    const actorB = { userId: adminB.id, organizationId: orgB.id };
    const operatorActor = { userId: operatorA.id, organizationId: orgA.id };

    await t.test("operador não gerencia equipe nem organizações, mesmo alegando outro perfil", async () => {
      await assert.rejects(upsertMember(db, operatorActor, member("rejeitado@access.invalid")));
      await assert.rejects(removeMember(db, operatorActor, operatorB.id));
      await assert.rejects(upsertOrganization(db, operatorActor, { name: "Nova" }));
      // O papel é lido do banco: uma claim forjada pelo chamador não concede acesso.
      const forged = { ...operatorActor, role: "PLATFORM_ADMIN" } as never;
      await assert.rejects(upsertMember(db, forged, member("forjado@access.invalid")));
    });

    await t.test("ator inexistente ou fora da organização informada é rejeitado", async () => {
      await assert.rejects(upsertMember(db, { userId: adminA.id, organizationId: orgB.id }, member("x1@access.invalid")));
      await assert.rejects(upsertMember(db, { userId: "inexistente", organizationId: orgA.id }, member("x2@access.invalid")));
    });

    await t.test("administrador de organização não cria usuário fora dela nem concede perfil de plataforma", async () => {
      await assert.rejects(upsertMember(db, actorA, member("fora@access.invalid", { organizationId: orgB.id })));
      await assert.rejects(upsertMember(db, actorA, member("elevado@access.invalid", { role: "PLATFORM_ADMIN" })));
      assert.equal(await db.user.count({ where: { email: { in: ["fora@access.invalid", "elevado@access.invalid"] } } }), 0);
    });

    await t.test("valida nome, e-mail, perfil e senha do novo usuário", async () => {
      for (const patch of [
        { email: "sem-arroba" }, { email: "sem@dominio" }, { email: "" }, { name: "" },
        { role: "SUPERUSER" }, { password: undefined }, { password: "curta" },
      ]) await assert.rejects(upsertMember(db, actorA, member("valida@access.invalid", patch)));
    });

    const created = await upsertMember(db, actorA, member("novo-a@access.invalid"));
    await t.test("criação grava na organização do ator, com hash de senha e auditoria", async () => {
      const user = await db.user.findUniqueOrThrow({ where: { id: created.id } });
      assert.equal(user.organizationId, orgA.id);
      assert.equal(user.email, "novo-a@access.invalid");
      assert.equal(user.role, "OPERATOR");
      assert.notEqual(user.passwordHash, password);
      const audit = await db.auditLog.findFirstOrThrow({ where: { entity: "USER", entityId: user.id } });
      assert.equal(audit.action, "CREATE");
      assert.equal(audit.userId, adminA.id);
      assert.equal(audit.organizationId, orgA.id);
      assert.equal(JSON.stringify(audit.newData).includes(password), false);
    });

    await t.test("e-mail duplicado não cria segundo usuário", async () => {
      await assert.rejects(upsertMember(db, actorA, member("novo-a@access.invalid")));
      assert.equal(await db.user.count({ where: { email: "novo-a@access.invalid" } }), 1);
    });

    await t.test("edição de usuário de outra organização e de operador da plataforma é negada", async () => {
      await assert.rejects(upsertMember(db, actorA, { id: operatorB.id, name: "Invadido", email: operatorB.email }));
      await assert.rejects(upsertMember(db, actorA, { id: platform.id, name: "Invadido", email: platform.email }));
      await assert.rejects(removeMember(db, actorA, operatorB.id));
      await assert.rejects(removeMember(db, actorA, platform.id));
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: operatorB.id } })).name, "Operador B");
      assert.equal(await db.user.count({ where: { id: platform.id } }), 1);
    });

    await t.test("ninguém altera o próprio perfil, se exclui ou se move de organização", async () => {
      await assert.rejects(upsertMember(db, actorA, { id: adminA.id, name: adminA.name, email: adminA.email, role: "OPERATOR" }));
      await assert.rejects(removeMember(db, actorA, adminA.id));
      await assert.rejects(upsertMember(db, platformActor, { id: platform.id, name: platform.name, email: platform.email, organizationId: orgB.id }));
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: adminA.id } })).role, "ADMIN");
    });

    await t.test("organização não fica sem administrador por rebaixamento, mudança ou exclusão", async () => {
      const demote = { id: onlyAdminC.id, name: onlyAdminC.name, email: onlyAdminC.email, role: "OPERATOR" };
      await assert.rejects(upsertMember(db, platformActor, demote));
      await assert.rejects(upsertMember(db, platformActor, { ...demote, role: "ADMIN", organizationId: orgA.id }));
      await assert.rejects(removeMember(db, platformActor, onlyAdminC.id));
      const kept = await db.user.findUniqueOrThrow({ where: { id: onlyAdminC.id } });
      assert.equal(kept.role, "ADMIN");
      assert.equal(kept.organizationId, orgC.id);
    });

    await t.test("operador da plataforma cria em outra organização, redefine senha e move usuário", async () => {
      const remote = await upsertMember(db, platformActor, member("novo-b@access.invalid", { organizationId: orgB.id }));
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: remote.id } })).organizationId, orgB.id);
      const before = await db.user.findUniqueOrThrow({ where: { id: operatorB.id } });
      await upsertMember(db, platformActor, {
        id: operatorB.id, name: "Operador Movido", email: operatorB.email, organizationId: orgA.id, password: "outra-senha-longa",
      });
      const moved = await db.user.findUniqueOrThrow({ where: { id: operatorB.id } });
      assert.equal(moved.organizationId, orgA.id);
      assert.equal(moved.name, "Operador Movido");
      assert.notEqual(moved.passwordHash, before.passwordHash);
      const audit = await db.auditLog.findFirstOrThrow({ where: { entity: "USER", entityId: operatorB.id, action: "UPDATE" } });
      assert.equal(audit.organizationId, orgA.id);
    });

    await t.test("exclusão preserva a trilha de auditoria do usuário removido", async () => {
      const target = await upsertMember(db, actorA, member("descartavel@access.invalid"));
      await removeMember(db, actorA, target.id);
      assert.equal(await db.user.count({ where: { id: target.id } }), 0);
      const logs = await db.auditLog.findMany({ where: { entity: "USER", entityId: target.id } });
      assert.deepEqual(logs.map((log) => log.action).sort(), ["CREATE", "DELETE"]);
    });

    await t.test("apenas operador da plataforma cria organizações; administrador renomeia só a própria", async () => {
      await assert.rejects(upsertOrganization(db, actorA, { name: "Tentativa" }));
      await assert.rejects(upsertOrganization(db, actorA, { id: orgB.id, name: "Renomeada por A" }));
      await assert.rejects(upsertOrganization(db, actorA, { id: orgA.id, name: "" }));
      await upsertOrganization(db, actorA, { id: orgA.id, name: "Access A Renomeada" });
      assert.equal((await db.organization.findUniqueOrThrow({ where: { id: orgA.id } })).name, "Access A Renomeada");
      const audit = await db.auditLog.findFirstOrThrow({ where: { entity: "ORGANIZATION", entityId: orgA.id, action: "UPDATE" } });
      assert.equal(audit.userId, adminA.id);
      const fresh = await upsertOrganization(db, platformActor, { name: "Criada pela Plataforma" });
      assert.equal(await db.auditLog.count({ where: { entity: "ORGANIZATION", entityId: fresh?.id, action: "CREATE" } }), 1);
    });

    await t.test("exclusão de organização exige plataforma, organização vazia e outra que não a própria", async () => {
      await assert.rejects(removeOrganization(db, actorB, orgB.id));
      await assert.rejects(removeOrganization(db, platformActor, orgA.id));
      await assert.rejects(removeOrganization(db, platformActor, orgB.id));
      await assert.rejects(removeOrganization(db, platformActor, "inexistente"));
      assert.equal(await db.organization.count({ where: { id: orgB.id } }), 1);
      await removeOrganization(db, platformActor, empty.id);
      assert.equal(await db.organization.count({ where: { id: empty.id } }), 0);
      const audit = await db.auditLog.findFirstOrThrow({ where: { entity: "ORGANIZATION", entityId: empty.id, action: "DELETE" } });
      assert.equal(audit.organizationId, orgA.id);
    });
  } finally { await db.$disconnect(); }
});
