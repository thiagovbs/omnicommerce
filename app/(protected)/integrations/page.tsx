import { redirect } from "next/navigation";
import { format } from "date-fns";
import { currentActor } from "@/lib/current-actor";
import { isOrgAdmin } from "@/lib/domain/roles";
import { prisma } from "@/lib/prisma";
import { RetryButton } from "./retry-button";

export const dynamic = "force-dynamic";
const statuses = { PENDING: "Pendente", PROCESSED: "Processado", IGNORED: "Evento antigo", FAILED: "Requer atenção" };
const deliveryStatuses = { PENDING: "Envio pendente", PUBLISHED: "Enviado", FAILED: "Falha no envio" };

export default async function IntegrationsPage() {
  const actor = await currentActor();
  if (!isOrgAdmin(actor.role)) redirect("/dashboard");
  const events = await prisma.integrationEvent.findMany({
    where: { marketplace: { organizationId: actor.organizationId } },
    orderBy: { receivedAt: "desc" }, take: 50,
    select: { id: true, externalOrderId: true, status: true, attempts: true, lastError: true, receivedAt: true,
      marketplace: { select: { name: true } }, outbox: { select: { status: true, lastError: true } },
    },
  });
  return <div className="mx-auto max-w-7xl p-8">
    <h1 className="text-3xl font-bold">Integrações</h1>
    <p className="mt-2 mb-6 text-gray-500">Últimos 50 eventos de pedidos desta organização. O reprocessamento agenda uma nova tentativa de entrega.</p>
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
