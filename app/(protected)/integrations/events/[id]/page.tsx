import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { format } from "date-fns";
import { currentActor } from "@/lib/current-actor";
import { OrderError } from "@/lib/domain/order-input";
import { isOrgAdmin } from "@/lib/domain/roles";
import { eventHistory } from "@/lib/services/event-history";
import { prisma } from "@/lib/prisma";
import { RetryButton } from "../../retry-button";

export const dynamic = "force-dynamic";

const statuses: Record<string, string> = {
  PENDING: "Pendente", PROCESSED: "Processado", IGNORED: "Evento antigo", FAILED: "Requer atenção",
};
const deliveryStatuses: Record<string, string> = {
  PENDING: "Envio pendente", PUBLISHED: "Enviado", FAILED: "Falha no envio",
};
const providerNames: Record<string, string> = {
  MERCADO_LIVRE: "Mercado Livre", SHOPEE: "Shopee", OLX: "OLX",
  FACEBOOK: "Facebook", SEBO_ONLINE: "Sebo On-Line",
};
const kinds: Record<string, string> = {
  PROCESSING: "Processamento", DELIVERY: "Entrega",
};
const outcomes: Record<string, { rotulo: string; cor: string }> = {
  OK: { rotulo: "Sucesso", cor: "text-green-700" },
  TRANSIENT: { rotulo: "Falha temporária", cor: "text-amber-700" },
  PERMANENT: { rotulo: "Falha definitiva", cor: "text-red-700" },
};

const quando = (data: Date) => format(data, "dd/MM/yyyy HH:mm:ss");

function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return <div>
    <dt className="text-xs uppercase tracking-wide text-gray-500">{rotulo}</dt>
    <dd className="mt-0.5 text-sm text-gray-900">{children}</dd>
  </div>;
}

/**
 * Histórico de um evento.
 *
 * A listagem mostra o ÚLTIMO erro, que é o que a coluna do evento guarda. Esta
 * tela existe para a pergunta que aquela coluna não responde: um evento que
 * falhou oito vezes falhou oito vezes pelo mesmo motivo? A primeira tentativa
 * foi recusa do provedor e as outras, timeout? Foi o processamento que falhou
 * ou a entrega para quem consome?
 */
export default async function EventHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await currentActor();
  if (!isOrgAdmin(actor.role)) redirect("/dashboard");
  const { id } = await params;

  let evento;
  try {
    evento = await eventHistory(prisma, actor, id);
  } catch (error) {
    // Evento de outra organização e evento inexistente dão na mesma resposta:
    // confirmar a existência já diria algo sobre o dado do vizinho.
    if (error instanceof OrderError) notFound();
    throw error;
  }

  const tentativas = evento.attemptLog;

  return <div className="mx-auto max-w-5xl p-4 sm:p-6 lg:p-8">
    <Link href="/integrations" className="text-sm text-blue-700 underline hover:text-blue-900">
      ← Voltar para Integrações
    </Link>

    <h1 className="mt-3 text-3xl font-bold">Evento de integração</h1>
    <p className="mt-1 text-sm text-gray-500">
      Pedido <span className="font-mono">{evento.externalOrderId}</span> em {evento.marketplace.name}
    </p>

    <dl className="mt-6 grid grid-cols-2 gap-4 rounded-xl border bg-white p-6 md:grid-cols-4">
      <Campo rotulo="Situação">
        <span className={evento.status === "FAILED" ? "text-red-700" : ""}>
          {statuses[evento.status] ?? evento.status}
        </span>
      </Campo>
      <Campo rotulo="Tentativas">{evento.attempts}</Campo>
      <Campo rotulo="Recebido">{quando(evento.receivedAt)}</Campo>
      <Campo rotulo="Processado">
        {evento.processedAt ? quando(evento.processedAt) : <span className="text-gray-400">—</span>}
      </Campo>
      <Campo rotulo="Canal">
        {evento.marketplace.name}
        {evento.marketplace.provider && <span className="text-gray-500">
          {" "}({providerNames[evento.marketplace.provider] ?? evento.marketplace.provider})
        </span>}
      </Campo>
      <Campo rotulo="Conta">
        {evento.connection
          ? <span className="font-mono text-xs">{evento.connection.externalAccountId}</span>
          : <span className="text-gray-400">sem conexão</span>}
      </Campo>
      <Campo rotulo="Identidade do aviso">
        <span className="font-mono text-xs break-all">{evento.externalEventId}</span>
      </Campo>
      <Campo rotulo="Último erro">
        {evento.lastError
          ? <span className="text-red-700">{evento.lastError}</span>
          : <span className="text-gray-400">—</span>}
      </Campo>
    </dl>

    {evento.status !== "PROCESSED" && evento.status !== "IGNORED" && <div className="mt-4">
      <RetryButton eventId={evento.id} />
    </div>}

    <h2 className="mt-8 text-xl font-semibold">Tentativas</h2>
    <p className="mt-1 mb-3 text-sm text-gray-500">
      Em ordem, do mais antigo para o mais recente. Inclui o processamento (falar com
      o provedor e aplicar a venda) e a entrega para quem consome os eventos.
    </p>
    {!tentativas.length
      ? <div className="rounded-xl border bg-white p-4 text-sm sm:p-6 text-gray-500">
          Sem tentativas registradas. O registro por tentativa passou a existir
          depois deste evento — o que se sabe dele está em “Último erro”, acima.
        </div>
      : <div className="rounded-xl border bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-gray-50"><tr>
                {["Quando", "Etapa", "Nº", "Resultado", "Duração", "Erro"].map((r) =>
                  <th key={r} className="p-3 sm:p-4">{r}</th>)}
              </tr></thead>
              <tbody className="divide-y">{tentativas.map((t) => <tr key={t.id}>
                <td className="p-3 sm:p-4 whitespace-nowrap">{quando(t.at)}</td>
                <td className="p-3 sm:p-4">{kinds[t.kind] ?? t.kind}</td>
                <td className="p-3 sm:p-4">{t.number}</td>
                <td className={`p-3 sm:p-4 ${outcomes[t.outcome]?.cor ?? ""}`}>
                  {outcomes[t.outcome]?.rotulo ?? t.outcome}
                </td>
                <td className="p-3 sm:p-4 text-gray-500">
                  {t.durationMs === null ? "—" : `${t.durationMs} ms`}
                </td>
                <td className="p-3 sm:p-4">
                  {t.errorClass && <div className="font-mono text-xs text-gray-700">{t.errorClass}</div>}
                  {t.error
                    ? <div className="text-xs text-red-700">{t.error}</div>
                    : t.errorClass && <div className="text-xs text-gray-500">
                        Mensagem não registrada: veio de fora e pode carregar credencial.
                      </div>}
                  {!t.errorClass && !t.error && <span className="text-gray-400">—</span>}
                </td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>}

    <h2 className="mt-8 text-xl font-semibold">Entrega</h2>
    {!evento.outbox
      ? <div className="mt-3 rounded-xl border bg-white p-4 text-sm sm:p-6 text-gray-500">
          Sem envio para este evento.
        </div>
      : <dl className="mt-3 grid grid-cols-2 gap-4 rounded-xl border bg-white p-6 md:grid-cols-4">
          <Campo rotulo="Situação">
            {deliveryStatuses[evento.outbox.status] ?? evento.outbox.status}
          </Campo>
          <Campo rotulo="Tentativas">{evento.outbox.attempts}</Campo>
          <Campo rotulo="Próxima tentativa">
            {evento.outbox.status === "PENDING" ? quando(evento.outbox.availableAt)
              : <span className="text-gray-400">—</span>}
          </Campo>
          <Campo rotulo="Publicado">
            {evento.outbox.publishedAt ? quando(evento.outbox.publishedAt)
              : <span className="text-gray-400">—</span>}
          </Campo>
          {evento.outbox.lastError && <div className="col-span-2 md:col-span-4">
            <Campo rotulo="Último erro do envio">
              <span className="font-mono text-xs text-red-700">{evento.outbox.lastError}</span>
            </Campo>
          </div>}
        </dl>}

    {evento.auditLogs.length > 0 && <>
      <h2 className="mt-8 text-xl font-semibold">Registro de auditoria</h2>
      <div className="mt-3 overflow-x-auto rounded-xl border bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-gray-50"><tr>
              {["Quando", "Quem", "O quê"].map((r) => <th key={r} className="p-3 sm:p-4">{r}</th>)}
            </tr></thead>
            <tbody className="divide-y">{evento.auditLogs.map((log) => <tr key={log.id}>
              <td className="p-3 sm:p-4 whitespace-nowrap">{quando(log.createdAt)}</td>
              <td className="p-3 sm:p-4">{log.user?.name ?? log.user?.email ?? "Sistema"}</td>
              <td className="p-3 sm:p-4">{log.details ?? `${log.action} ${log.entity}`}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>
    </>}

    {/* O aviso como chegou. Fechado por padrão porque é diagnóstico, não
        leitura: quem abre a tela quer saber o que falhou, e só desce até aqui
        quando o erro não bastou. */}
    <details className="mt-8 rounded-xl border bg-white p-4 sm:p-6">
      <summary className="cursor-pointer text-sm font-semibold">Aviso recebido do provedor</summary>
      <pre className="mt-3 overflow-x-auto rounded bg-gray-50 p-4 text-xs">
        {JSON.stringify(evento.payload, null, 2)}
      </pre>
    </details>
  </div>;
}
