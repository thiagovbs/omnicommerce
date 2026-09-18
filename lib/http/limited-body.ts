import { OrderError } from "../domain/order-input";

// Lê o corpo com teto de bytes, cancelando o fluxo em vez de acumular o que chegar.
export async function readLimitedText(request: Request, limit: number) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new OrderError("Mensagem excede o limite."); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts).toString("utf8");
}
