import { redirect } from "next/navigation";
import { format } from "date-fns";
import { currentActor } from "@/lib/current-actor";
import { providerDoCanal } from "@/lib/domain/marketplace-provider";
import { isOrgAdmin } from "@/lib/domain/roles";
import { oauthConfigured } from "@/lib/integrations/mercadolivre/oauth";
import { olxOauthConfigured } from "@/lib/integrations/olx/oauth";
import { shopeeConfig, shopeeConfigured } from "@/lib/integrations/shopee/client";
import { prisma } from "@/lib/prisma";
import { RetryButton } from "./retry-button";

export const dynamic = "force-dynamic";
const statuses = { PENDING: "Pendente", PROCESSED: "Processado", IGNORED: "Evento antigo", FAILED: "Requer atenção" };
const deliveryStatuses = { PENDING: "Envio pendente", PUBLISHED: "Enviado", FAILED: "Falha no envio" };
const connectionStatuses = { ACTIVE: "Ativa", INACTIVE: "Inativa", EXPIRED: "Expirada" };
const providerNames = {
  MERCADO_LIVRE: "Mercado Livre", SHOPEE: "Shopee", OLX: "OLX", SEBO_ONLINE: "Sebo On-Line",
};

/**
 * Quem se conecta por OAuth, e por qual rota.
 *
 * Derivado do provedor, e não do código do canal: é o provedor que define o
 * fluxo de autorização. O Sebo On-Line fica de fora porque a credencial dele é
 * token de serviço, registrado por script -- não há tela a oferecer.
 *
 * `variaveis` existe para o aviso de indisponível dizer O QUE falta. Sem isso,
 * o botão simplesmente não aparece e ninguém sabe por quê.
 */
const oauthPorProvedor = {
  MERCADO_LIVRE: {
    rota: "mercadolivre",
    variaveis: "MERCADO_LIVRE_APP_ID e MERCADO_LIVRE_APP_SECRET",
  },
  SHOPEE: { rota: "shopee", variaveis: "SHOPEE_PARTNER_ID e SHOPEE_PARTNER_KEY" },
  OLX: { rota: "olx", variaveis: "OLX_CLIENT_ID e OLX_CLIENT_SECRET" },
} as const;

type ProvedorComOauth = keyof typeof oauthPorProvedor;

function temOauth(provider: string): provider is ProvedorComOauth {
  return provider in oauthPorProvedor;
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ conectado?: string; erro?: string }>;
}) {
  const actor = await currentActor();
  if (!isOrgAdmin(actor.role)) redirect("/dashboard");
  const aviso = await searchParams;
  const disponivel: Record<ProvedorComOauth, boolean> = {
    MERCADO_LIVRE: oauthConfigured(),
    SHOPEE: shopeeConfigured(),
    OLX: olxOauthConfigured(),
  };
  // Sandbox é informação de tela: sem ela, anúncio de teste e anúncio de
  // verdade ficam com a mesma aparência aqui.
  let shopeeSandbox = false;
  try { shopeeSandbox = shopeeConfig().sandbox; } catch { shopeeSandbox = false; }

  const [marketplaces, events] = await Promise.all([
    prisma.marketplace.findMany({
      where: { organizationId: actor.organizationId, active: true },
      orderBy: { name: "asc" },
      select: {
        id: true, name: true, code: true,
        connections: {
          orderBy: { createdAt: "asc" },
          select: { id: true, provider: true, externalAccountId: true, status: true, expiresAt: true, lastSyncedAt: true },
        },
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

  return <div className="mx-auto max-w-7xl p-8">
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
    {Object.entries(oauthPorProvedor)
      .filter(([provider]) => !disponivel[provider as ProvedorComOauth])
      .map(([provider, { variaveis }]) => <p key={provider} className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
        A autorização do {providerNames[provider as ProvedorComOauth]} está indisponível: falta
        configurar <span className="font-mono">{variaveis}</span> no ambiente.
      </p>)}
    {shopeeSandbox && <p className="mb-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
      A Shopee está apontada para o <strong>sandbox</strong>. Anúncio publicado aqui não
      aparece na loja real.
    </p>}
    <div className="overflow-x-auto rounded-xl border bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b bg-gray-50"><tr>
          {["Canal", "Conexões", "Ações"].map((label) => <th key={label} className="p-4">{label}</th>)}
        </tr></thead>
        <tbody className="divide-y">{marketplaces.map((marketplace) => <tr key={marketplace.id}>
          <td className="p-4 align-top">
            {marketplace.name}
            <div className="font-mono text-xs text-gray-500">{marketplace.code}</div>
          </td>
          <td className="p-4 align-top">
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
                {temOauth(connection.provider) && disponivel[connection.provider] && <a
                  href={`/api/integrations/${oauthPorProvedor[connection.provider].rota}/authorize?marketplaceId=${marketplace.id}&connectionId=${connection.id}`}
                  className="mt-1 inline-block text-xs text-blue-700 underline hover:text-blue-900"
                >
                  Reautorizar esta conta
                </a>}
              </div>)}
          </td>
          <td className="p-4 align-top">
            {(() => {
              const provider = providerDoCanal(marketplace.code);
              // Canal sem provedor de OAuth não tem o que oferecer aqui: ou não
              // tem integração, ou a credencial dele não nasce de autorização.
              if (!provider || !temOauth(provider)) return <span className="text-gray-400">—</span>;
              if (!disponivel[provider]) return <span className="text-gray-400">Indisponível</span>;
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
      {!marketplaces.length && <div className="p-8 text-gray-500">
        Nenhum canal ativo. Cadastre um marketplace antes de conectar uma conta.
      </div>}
    </div>

    <h2 className="mt-10 text-xl font-semibold">Eventos</h2>
    <p className="mt-1 mb-4 text-sm text-gray-500">Últimos 50 eventos de pedidos desta organização. O reprocessamento agenda uma nova tentativa de entrega.</p>
    {!events.length ? <div className="rounded-xl border bg-white p-8 text-gray-500">Nenhum evento recebido. Os eventos aparecerão após configurar uma integração.</div> :
      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-gray-50"><tr>{["Recebido", "Marketplace / Pedido", "Processamento", "Entrega", "Ações"].map((label) => <th key={label} className="p-4">{label}</th>)}</tr></thead>
          <tbody className="divide-y">{events.map((event) => <tr key={event.id}>
            <td className="p-4">{format(event.receivedAt, "dd/MM/yyyy HH:mm:ss")}</td>
            <td className="p-4">{event.marketplace.name}<div className="font-mono text-xs">{event.externalOrderId}</div></td>
            <td className="p-4">{statuses[event.status]}<div className="text-xs text-gray-500">Tentativas: {event.attempts}</div>{event.lastError && <div className="max-w-xs text-xs text-red-600">{event.lastError}</div>}</td>
            <td className="p-4">{event.outbox ? deliveryStatuses[event.outbox.status] : "Sem envio"}{event.outbox?.lastError && <div className="text-xs text-red-600">Não foi possível publicar.</div>}</td>
            <td className="p-4">{event.status !== "PROCESSED" && event.status !== "IGNORED" && <RetryButton eventId={event.id} />}</td>
          </tr>)}</tbody>
        </table>
      </div>}
  </div>;
}
