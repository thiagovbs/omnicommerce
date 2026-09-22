import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { MarketplaceProvider, PrismaClient } from "@prisma/client";
import {
  camposDoProvedor, codigoDoProvedor, faltaParaConfigurar, parseMarketplaceSettings,
  PROVEDORES, rotuloDoProvedor,
} from "../domain/marketplace-config";
import { objectInput, OrderError, textInput } from "../domain/order-input";
import { decryptSecret, encryptSecret } from "../integrations/crypto";
import { assertOrgAdmin } from "./access";
import { UserActor } from "./actor";
import { serializable } from "./transactions";

/**
 * Canais e a configuração de integração de cada um.
 *
 * O que mudou de lugar: as credenciais de cada provedor moravam no ambiente do
 * deploy -- um App ID do Mercado Livre, uma URL do Sebo -- e por isso serviam
 * todas as organizações ao mesmo tempo. Uma organização nova dependia de
 * alguém mexer em variável de ambiente. Aqui elas são do canal, e o canal é de
 * uma organização.
 *
 * Duas regras atravessam o arquivo:
 *
 * 1. **Segredo não volta.** O que é segredo é gravado cifrado e nunca sai
 *    daqui em direção à tela; a tela sabe apenas se está preenchido.
 * 2. **Auditoria registra a chave, não o valor.** Gravar o valor no log
 *    anularia a cifra -- o log é lido por mais gente que o cofre.
 */

/// Identifica o segredo de webhook por VALOR, sem decifrar registro por
/// registro. O ciphertext tem IV aleatório, então dois registros do mesmo
/// segredo são bytes diferentes e a busca por igualdade não acha nada.
export function hashDeBusca(valor: string): string {
  return createHash("sha256").update(valor, "utf8").digest("hex");
}

export interface CanalComConfig {
  id: string;
  name: string;
  code: string;
  provider: MarketplaceProvider | null;
  active: boolean;
  /// Chaves preenchidas. Para segredo, é só a existência -- o valor não vem.
  preenchidas: string[];
  /// Rótulos do que é obrigatório e está em branco.
  falta: string[];
}

/**
 * Canais da organização com o estado da configuração de cada um.
 *
 * Devolve `preenchidas` em vez dos valores dos segredos: a tela precisa dizer
 * "App Secret: configurado" e oferecer a troca, e para isso não precisa ver o
 * segredo -- nem deve.
 */
export async function listMarketplaces(
  db: PrismaClient, actor: UserActor,
): Promise<CanalComConfig[]> {
  const canais = await db.marketplace.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, code: true, provider: true, active: true,
      settings: { select: { key: true } },
    },
  });
  return canais.map((canal) => {
    const preenchidas = canal.settings.map((s) => s.key);
    return {
      id: canal.id, name: canal.name, code: canal.code,
      provider: canal.provider, active: canal.active,
      preenchidas,
      falta: canal.provider ? faltaParaConfigurar(canal.provider, preenchidas) : [],
    };
  });
}

/**
 * Cria ou renomeia um canal, a partir do provedor escolhido na lista.
 *
 * O provedor é a identidade do canal: o `code` deriva dele em vez de ser
 * digitado. Antes, quem digitasse um código fora da lista de nomes conhecidos
 * ficava com um canal que nunca se conectava, sem nenhum erro na tela.
 *
 * Provedor repetido na mesma organização é recusado nomeando o canal que já
 * existe. Não é gosto: a conexão é única por (provedor, conta), então
 * autorizar a partir do segundo canal MOVE a conexão para ele, e os pedidos
 * passam a entrar no canal errado sem nenhum erro.
 */
export async function upsertMarketplace(db: PrismaClient, actor: UserActor, input: unknown) {
  const data = objectInput(input);
  const id = data.id === undefined || data.id === null || data.id === ""
    ? null : textInput(data.id, "Canal");
  const name = textInput(data.name, "Nome", 120);
  const active = typeof data.active === "boolean" ? data.active : true;
  const provider = providerDaEntrada(data.provider);

  return serializable(db, async (tx) => {
    await assertOrgAdmin(tx, actor);

    const duplicado = await tx.marketplace.findFirst({
      where: {
        organizationId: actor.organizationId, provider,
        ...(id ? { id: { not: id } } : {}),
      },
      select: { name: true },
    });
    if (duplicado) {
      throw new OrderError(
        `${rotuloDoProvedor(provider)} já está cadastrado no canal ${duplicado.name}.`
        + " Use aquele canal: várias contas do mesmo provedor cabem dentro dele.");
    }

    if (!id) {
      const canal = await tx.marketplace.create({ data: {
        organizationId: actor.organizationId,
        name, code: codigoDoProvedor(provider), provider, active,
      } });
      await tx.auditLog.create({ data: {
        action: "CREATE", entity: "MARKETPLACE", entityId: canal.id,
        organizationId: actor.organizationId, userId: actor.userId,
        details: `Canal ${name} (${rotuloDoProvedor(provider)}) criado.`,
        newData: { name, provider, code: canal.code, active },
      } });
      return { id: canal.id };
    }

    const existente = await tx.marketplace.findFirst({
      where: { id, organizationId: actor.organizationId },
      select: { name: true, code: true, provider: true, active: true },
    });
    if (!existente) throw new OrderError("Canal não encontrado.");

    // Trocar o provedor de um canal que já tem conexão, anúncio ou venda
    // levaria o histórico para outro provedor. Recusa nomeando o motivo.
    if (existente.provider && existente.provider !== provider) {
      const [conexoes, anuncios, vendas] = await Promise.all([
        tx.marketplaceConnection.count({ where: { marketplaceId: id } }),
        tx.listing.count({ where: { marketplaceId: id } }),
        tx.sale.count({ where: { marketplaceId: id } }),
      ]);
      if (conexoes || anuncios || vendas) {
        throw new OrderError(
          "Não é possível trocar o provedor de um canal que já tem histórico"
          + ` (${conexoes} conexão(ões), ${anuncios} anúncio(s), ${vendas} venda(s)).`
          + " Crie outro canal.");
      }
    }

    const code = codigoDoProvedor(provider);
    const mudancas = (["name", "code", "provider", "active"] as const)
      .filter((campo) => ({ name, code, provider, active })[campo] !== existente[campo]);
    if (!mudancas.length) return { id, mudancas: 0 };

    await tx.marketplace.update({ where: { id }, data: { name, code, provider, active } });
    await tx.auditLog.create({ data: {
      action: "UPDATE", entity: "MARKETPLACE", entityId: id,
      organizationId: actor.organizationId, userId: actor.userId,
      details: `Canal ${name}: ${mudancas.join(", ")}.`,
      oldData: Object.fromEntries(mudancas.map((c) => [c, existente[c]])),
      newData: Object.fromEntries(mudancas.map((c) => [c, { name, code, provider, active }[c]])),
    } });
    return { id, mudancas: mudancas.length };
  });
}

function providerDaEntrada(valor: unknown): MarketplaceProvider {
  const texto = textInput(valor, "Provedor", 40);
  // Derivado do catálogo que a tela oferece: uma lista própria aqui já
  // ficou para trás uma vez, e o sintoma é a tela oferecer um provedor que
  // o servidor recusa.
  const conhecidos: MarketplaceProvider[] = PROVEDORES.map((p) => p.provider);
  const provider = conhecidos.find((p) => p === texto);
  if (!provider) throw new OrderError("Provedor inválido.");
  return provider;
}

export async function deleteMarketplace(db: PrismaClient, actor: UserActor, marketplaceId: string) {
  const id = textInput(marketplaceId, "Canal");
  return serializable(db, async (tx) => {
    await assertOrgAdmin(tx, actor);
    const canal = await tx.marketplace.findFirst({
      where: { id, organizationId: actor.organizationId },
      select: { name: true },
    });
    if (!canal) throw new OrderError("Canal não encontrado.");
    await tx.marketplace.delete({ where: { id } });
    await tx.auditLog.create({ data: {
      action: "DELETE", entity: "MARKETPLACE", entityId: id,
      organizationId: actor.organizationId, userId: actor.userId,
      details: `Canal ${canal.name} excluído.`, oldData: { name: canal.name },
    } });
    return { id };
  });
}

/**
 * Grava a configuração do canal.
 *
 * Campo em branco APAGA o registro, em vez de gravar string vazia: vazio e
 * ausente têm de significar a mesma coisa, senão "configurado" passa a ser
 * verdade para um canal que não funciona.
 */
export async function saveMarketplaceSettings(
  db: PrismaClient, actor: UserActor, marketplaceId: string, entrada: unknown,
) {
  const id = textInput(marketplaceId, "Canal");
  return serializable(db, async (tx) => {
    await assertOrgAdmin(tx, actor);
    const canal = await tx.marketplace.findFirst({
      where: { id, organizationId: actor.organizationId },
      select: { name: true, provider: true },
    });
    if (!canal) throw new OrderError("Canal não encontrado.");
    if (!canal.provider) {
      throw new OrderError("Canal sem provedor: escolha o provedor antes de configurar.");
    }

    const valores = parseMarketplaceSettings(canal.provider, entrada);
    const informadas = new Set(Object.keys(objectInput(entrada)));
    const atuais = await tx.marketplaceSetting.findMany({
      where: { marketplaceId: id }, select: { key: true, value: true, secret: true },
    });
    const porChave = new Map(atuais.map((s) => [s.key, s]));

    const gravadas: string[] = [];
    const apagadas: string[] = [];

    for (const [key, { valor, segredo, buscavel }] of Object.entries(valores)) {
      const atual = porChave.get(key);
      // Segredo não é comparável sem decifrar, e decifrar para comparar é
      // trabalho à toa: só grava quando o valor chega diferente do atual.
      if (atual && !atual.secret && atual.value === valor) continue;
      if (atual && atual.secret && decryptSecret(atual.value) === valor) continue;
      await tx.marketplaceSetting.upsert({
        where: { marketplaceId_key: { marketplaceId: id, key } },
        update: {
          value: segredo ? encryptSecret(valor) : valor,
          secret: segredo,
          lookupHash: buscavel ? hashDeBusca(valor) : null,
        },
        create: {
          marketplaceId: id, key,
          value: segredo ? encryptSecret(valor) : valor,
          secret: segredo,
          lookupHash: buscavel ? hashDeBusca(valor) : null,
        },
      });
      gravadas.push(key);
    }

    // Apaga só o que a tela mandou em branco. Um formulário que não enviou a
    // chave não está pedindo remoção -- está falando de outra coisa.
    for (const campo of camposDoProvedor(canal.provider)) {
      if (!informadas.has(campo.chave)) continue;
      if (valores[campo.chave]) continue;
      if (!porChave.has(campo.chave)) continue;
      await tx.marketplaceSetting.delete({
        where: { marketplaceId_key: { marketplaceId: id, key: campo.chave } },
      });
      apagadas.push(campo.chave);
    }

    if (gravadas.length || apagadas.length) {
      await tx.auditLog.create({ data: {
        action: "UPDATE", entity: "MARKETPLACE", entityId: id,
        organizationId: actor.organizationId, userId: actor.userId,
        // Só nomes de campo: o valor é credencial e o log é lido por mais
        // gente que o cofre.
        details: `Configuração de ${canal.name}:`
          + `${gravadas.length ? ` alterou ${gravadas.join(", ")}.` : ""}`
          + `${apagadas.length ? ` apagou ${apagadas.join(", ")}.` : ""}`,
        newData: { alteradas: gravadas, apagadas },
      } });
    }

    const restantes = await tx.marketplaceSetting.findMany({
      where: { marketplaceId: id }, select: { key: true },
    });
    return {
      alteradas: gravadas.length,
      apagadas: apagadas.length,
      falta: faltaParaConfigurar(canal.provider, restantes.map((s) => s.key)),
    };
  });
}

/**
 * Configuração de um canal, com os segredos em claro, para quem vai CHAMAR o
 * provedor.
 *
 * Sem ator de propósito: quem usa isto é o job de fila e o recebedor de
 * webhook, que rodam sem usuário. O controle de acesso está em quem escolhe o
 * `marketplaceId` -- e quem o escolhe é código nosso, a partir da conexão que
 * o aviso resolveu.
 */
export async function marketplaceSettings(
  db: PrismaClient, marketplaceId: string,
): Promise<Record<string, string>> {
  const linhas = await db.marketplaceSetting.findMany({
    where: { marketplaceId }, select: { key: true, value: true, secret: true },
  });
  const saida: Record<string, string> = {};
  for (const linha of linhas) {
    saida[linha.key] = linha.secret ? decryptSecret(linha.value) : linha.value;
  }
  return saida;
}

/// A configuração do canal de um provedor numa organização. É o atalho de quem
/// já sabe a organização (a tela) e precisa falar com o provedor.
export async function settingsDoProvedor(
  db: PrismaClient, organizationId: string, provider: MarketplaceProvider,
) {
  const canal = await db.marketplace.findFirst({
    where: { organizationId, provider }, select: { id: true },
  });
  if (!canal) return {};
  return marketplaceSettings(db, canal.id);
}

/**
 * Acha o canal pelo segredo que veio na URL do webhook.
 *
 * O provedor chama a URL sem dizer de quem é o aviso, então o segredo é o que
 * identifica o tenant. A busca é pelo hash; a confirmação é comparação de
 * tempo constante sobre o hash, para o tempo de resposta não revelar quantos
 * caracteres estavam certos.
 */
export async function canalPorSegredoDeWebhook(
  db: PrismaClient, provider: MarketplaceProvider, segredo: string,
): Promise<{ marketplaceId: string } | null> {
  if (!segredo) return null;
  const hash = hashDeBusca(segredo);
  const candidatos = await db.marketplaceSetting.findMany({
    where: { key: "webhookSecret", lookupHash: hash, marketplace: { provider } },
    select: { marketplaceId: true, lookupHash: true },
  });
  const esperado = Buffer.from(hash);
  for (const candidato of candidatos) {
    const atual = Buffer.from(candidato.lookupHash ?? "");
    if (atual.length === esperado.length && timingSafeEqual(atual, esperado)) {
      return { marketplaceId: candidato.marketplaceId };
    }
  }
  return null;
}
