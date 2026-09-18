import "server-only";
import { timingSafeEqual } from "node:crypto";
import { objectInput, OrderError, textInput } from "../domain/order-input";
import { readLimitedText } from "../http/limited-body";
import { MessagingConfigurationError, messagingConfig, verifyJobSignature } from "./qstash";

export async function handleOrderJob(request: Request, processEvent: (eventId: string) => Promise<string>) {
  try { messagingConfig(); } catch { return Response.json({ error: "Mensageria não configurada." }, { status: 503 }); }
  const signature = request.headers.get("upstash-signature");
  if (!signature) return Response.json({ error: "Não autorizado." }, { status: 401 });
  let body: string;
  try { body = await readLimitedText(request, 4096); }
  catch { return Response.json({ error: "Mensagem inválida." }, { status: 413 }); }
  if (!await verifyJobSignature(signature, body)) return Response.json({ error: "Não autorizado." }, { status: 401 });
  let eventId: string;
  try { eventId = textInput(objectInput(JSON.parse(body)).eventId, "Evento"); }
  catch { return Response.json({ error: "Mensagem inválida." }, { status: 400 }); }
  try { return Response.json({ status: await processEvent(eventId) }); }
  catch (error) {
    // Domain errors have been persisted by the processor and require operator intervention.
    if (error instanceof OrderError) return Response.json({ status: "FAILED" });
    return Response.json({ error: "Falha temporária no processamento." }, { status: 500 });
  }
}

export async function handleDispatchJob(request: Request, dispatch: () => Promise<unknown>) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return Response.json({ error: "Agendamento não configurado." }, { status: 503 });
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return Response.json({ error: "Não autorizado." }, { status: 401 });
  }
  try { return Response.json(await dispatch()); }
  catch (error) {
    return Response.json({ error: "Publicação indisponível." }, { status: error instanceof MessagingConfigurationError ? 503 : 500 });
  }
}
