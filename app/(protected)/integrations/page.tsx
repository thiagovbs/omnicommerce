import { redirect } from "next/navigation";
import { format } from "date-fns";
import { currentActor } from "@/lib/current-actor";
import { MarketplaceProvider } from "@prisma/client";
import { isOrgAdmin } from "@/lib/domain/roles";
import { faltaParaConfigurar } from "@/lib/domain/marketplace-config";
import { prisma } from "@/lib/prisma";
import { RetryButton } from "./retry-button";

export const dynamic = "force-dynamic";
const statuses = { PENDING: "Pendente", PROCESSED: "Processado", IGNORED: "Evento antigo", FAILED: "Requer atenção" };
const deliveryStatuses = { PENDING: "Envio pendente", PUBLISHED: "Enviado", FAILED: "Falha no envio" };
const connectionStatuses = { ACTIVE: "Ativa", INACTIVE: "Inativa", EXPIRED: "Expirada" };
const providerNames = {
  MERCADO_LIVRE: "Mercado Livre", SHOPEE: "Shopee", OLX: "OLX",
  FACEBOOK: "Facebook", SEBO_ONLINE: "Sebo On-Line",
};

/**
 * Quem se conecta por OAuth, e por qual rota.
 *
 * Derivado do provedor, e não do código do canal: é o provedor que define o
 * fluxo de autorização. O Sebo On-Line fica de fora porque a credencial dele é
 * token de serviço, registrado por script -- não há tela a oferecer.
 *
 * O que falta para cada canal não está mais escrito aqui: vem do catálogo de
 * campos por provedor, o mesmo que a tela de Marketplaces usa. Antes eram nomes
 * de variável de ambiente, que não diziam nada a quem só tem acesso à tela.
 */
const oauthPorProvedor = {
  MERCADO_LIVRE: { rota: "mercadolivre" },
  SHOPEE: { rota: "shopee" },
  OLX: { rota: "olx" },
  FACEBOOK: { rota: "facebook" },
} as const;

type ProvedorComOauth = keyof typeof oauthPorProvedor;

function temOauth(provider: string): provider is ProvedorComOauth {
  return provider in oauthPorProvedor;
}

/// Canal como esta tela o lê: provedor mais as CHAVES configuradas.
interface CanalDaTela {
  provider: MarketplaceProvider | null;
  settings: { key: string; value: string; secret: boolean }[];
}

/// O que falta preencher, em rótulo de tela. Olha apenas quais chaves existem
/// -- não precisa do valor de nenhuma credencial para responder.
function falta(canal: CanalDaTela): string[] {
  if (!canal.provider) return [];
  return faltaParaConfigurar(canal.provider, canal.settings.map((s) => s.key));
}

/// Sandbox não é segredo, e é o que diferencia anúncio de teste de anúncio de
/// verdade nesta tela.
function ehSandbox(canal: CanalDaTela): boolean {
  return canal.settings.some((s) => !s.secret && s.key === "sandbox" && s.value === "true");
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ conectado?: string; erro?: string }>;
}) {
  const actor = await currentActor();
  if (!isOrgAdmin(actor.role)) redirect("/dashboard");
  const aviso = await searchParams;

  const [marketplaces, events] = await Promise.all([
    prisma.marketplace.findMany({
      where: { organizationId: actor.organizationId, active: true },
      orderBy: { name: "asc" },
      select: {
        id: true, name: true, code: true, provider: true,
        connections: {
          orderBy: { createdAt: "asc" },
          select: { id: true, provider: true, externalAccountId: true, status: true, expiresAt: true, lastSyncedAt: true },
        },
        // Só a CHAVE e o valor do que não é segredo: a tela precisa saber o
        // que está preenchido e se a Shopee aponta para o sandbox, e não
        // precisa ver credencial nenhuma para isso.
        settings: { select: { key: true, value: true, secret: true } },
      },
    }),
    prisma.integrationEvent.findMany({
      where: { marketplace: { organizationId: actor.organizationId } },
      orderBy: { receivedAt: "desc" }, take: 50,
      select: { id: true, externalOrderId: true, status: true, attempts: true, lastError: true, receivedAt: true,
        marketplace: { select: { name: true } }, outbox: { select: { status: true, lastError: true } },
      },
    }),
  ]);

  return <div className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">
    <h1 className="text-3xl font-bold">Integrações</h1>

    {aviso.conectado && <p role="status" className="mt-4 rounded-lg bg-green-50 p-3 text-sm text-green-800">
      Conta conectada. Os pedidos passam a chegar nos próximos avisos do provedor.
    </p>}
    {aviso.erro && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">
      Não foi possível concluir a autorização: {aviso.erro === "estado" ? "a sessão de autorização expirou ou não corresponde. Tente novamente."
        : aviso.erro === "autorizacao" ? "a autorização foi recusada no provedor."
        : aviso.erro === "marketplace" ? "marketplace inválido ou inativo."
        : aviso.erro === "conexao" ? "a conexão que se pediu para reautorizar não existe mais neste canal."
        : aviso.erro === "falha" ? "falha inesperada ao falar com o provedor." : aviso.erro}
    </p>}

    <h2 className="mt-8 text-xl font-semibold">Conexões</h2>
    <p className="mt-1 mb-4 text-sm text-gray-500">
      Cada conexão é uma loja autorizada. É ela que diz de qual organização é o pedido que chega.
    </p>
    {/* O aviso é POR CANAL, porque a configuração é do canal: numa plataforma
        com várias organizações, o Mercado Livre de uma pode estar configurado
        e o da outra não. E o que falta é nomeado com o rótulo da tela, não com
        o nome de uma variável de ambiente que ninguém tem acesso. */}
    {marketplaces
      .filter((m) => m.provider && temOauth(m.provider) && falta(m).length > 0)
      .map((m) => <p key={m.id} className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
        A autorização de {m.name} está indisponível: falta preencher{" "}
        <strong>{falta(m).join(", ")}</strong> em{" "}
        <a href="/marketplaces" className="underline">Marketplaces</a>.
      </p>)}
    {marketplaces.some((m) => m.provider === "SHOPEE" && ehSandbox(m))
      && <p className="mb-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
        A Shopee está apontada para o <strong>sandbox</strong>. Anúncio publicado aqui não
        aparece na loja real.
      </p>}
    <div className="rounded-xl border bg-white">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-gray-50"><tr>
            {["Canal", "Conexões", "Ações"].map((label) => <th key={label} className="p-3 sm:p-4">{label}</th>)}
          </tr></thead>
          <tbody className="divide-y">{marketplaces.map((marketplace) => <tr key={marketplace.id}>
            <td className="p-3 align-top sm:p-4">
              {marketplace.name}
              <div className="font-mono text-xs text-gray-500">{marketplace.code}</div>
            </td>
            <td className="p-3 align-top sm:p-4">
              {!marketplace.connections.length ? <span className="text-gray-500">Nenhuma</span> :
                marketplace.connections.map((connection) => <div key={connection.id} className="mb-2 last:mb-0">
                  {providerNames[connection.provider]} · <span className="font-mono text-xs">{connection.externalAccountId}</span>
                  <div className={`text-xs ${connection.status === "ACTIVE" ? "text-gray-500" : "text-red-600"}`}>
                    {connectionStatuses[connection.status]}
                    {connection.expiresAt && ` · credencial até ${format(connection.expiresAt, "dd/MM/yyyy HH:mm")}`}
                    {connection.lastSyncedAt && ` · sincronizada ${format(connection.lastSyncedAt, "dd/MM/yyyy HH:mm")}`}
                  </div>
                  {/* Reautorização é POR CONTA: com duas contas no mesmo canal,
                      um botão só não diz qual delas renovar -- e a que o
                      provedor devolve é a que estiver logada nele. */}
                  {temOauth(connection.provider) && !falta(marketplace).length && <a
                    href={`/api/integrations/${oauthPorProvedor[connection.provider].rota}/authorize?marketplaceId=${marketplace.id}&connectionId=${connection.id}`}
                    className="mt-1 inline-block text-xs text-blue-700 underline hover:text-blue-900"
                  >
                    Reautorizar esta conta
                  </a>}
                </div>)}
            </td>
            <td className="p-3 align-top sm:p-4">
              {(() => {
                const provider = marketplace.provider;
                // Canal sem provedor de OAuth não tem o que oferecer aqui: ou não
                // tem integração, ou a credencial dele não nasce de autorização.
                if (!provider || !temOauth(provider)) return <span className="text-gray-400">—</span>;
                // Sem as credenciais do canal, o clique cairia num 500. O aviso
                // acima já diz o que preencher.
                if (falta(marketplace).length) return <span className="text-gray-400">Indisponível</span>;
                const jaTem = marketplace.connections.some((c) => c.provider === provider);
                return <a
                  href={`/api/integrations/${oauthPorProvedor[provider].rota}/authorize?marketplaceId=${marketplace.id}`}
                  className="inline-block rounded border px-3 py-1 hover:bg-gray-50"
                >
                  {jaTem ? "Conectar outra conta" : `Conectar ${providerNames[provider]}`}
                </a>;
              })()}
            </td>
          </tr>)}</tbody>
        </table>
      </div>
      {!marketplaces.length && <div className="p-8 text-gray-500">
        Nenhum canal ativo. Cadastre um marketplace antes de conectar uma conta.
      </div>}
    </div>

    <h2 className="mt-10 text-xl font-semibold">Eventos</h2>
    <p className="mt-1 mb-4 text-sm text-gray-500">Últimos 50 eventos de pedidos desta organização. A coluna de processamento mostra a ÚLTIMA falha; o histórico de cada evento mostra tentativa por tentativa. O reprocessamento agenda uma nova tentativa de entrega.</p>
    {!events.length ? <div className="rounded-xl border bg-white p-8 text-gray-500">Nenhum evento recebido. Os eventos aparecerão após configurar uma integração.</div> :
      <div className="rounded-xl border bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-gray-50"><tr>{["Recebido", "Marketplace / Pedido", "Processamento", "Entrega", "Ações"].map((label) => <th key={label} className="p-3 sm:p-4">{label}</th>)}</tr></thead>
            <tbody className="divide-y">{events.map((event) => <tr key={event.id}>
              <td className="p-3 sm:p-4">{format(event.receivedAt, "dd/MM/yyyy HH:mm:ss")}</td>
              <td className="p-3 sm:p-4">{event.marketplace.name}<div className="font-mono text-xs">{event.externalOrderId}</div></td>
              <td className="p-3 sm:p-4">{statuses[event.status]}<div className="text-xs text-gray-500">Tentativas: {event.attempts}</div>{event.lastError && <div className="max-w-xs text-xs text-red-600">{event.lastError}</div>}</td>
              <td className="p-3 sm:p-4">{event.outbox ? deliveryStatuses[event.outbox.status] : "Sem envio"}{event.outbox?.lastError && <div className="font-mono text-xs text-red-600">{event.outbox.lastError}</div>}</td>
              <td className="p-3 sm:p-4">
                {/* O histórico é o caminho para "por que ESTE não entrou": a
                    coluna de erro guarda só a última tentativa. */}
                <a href={`/integrations/events/${event.id}`} className="text-blue-700 underline hover:text-blue-900">Histórico</a>
                {event.status !== "PROCESSED" && event.status !== "IGNORED" && <div className="mt-2"><RetryButton eventId={event.id} /></div>}
              </td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>}
  </div>;
}
