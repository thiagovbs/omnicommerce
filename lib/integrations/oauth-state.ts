import "server-only";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { OrderError } from "../domain/order-input";
import { decryptSecret, encryptSecret } from "./crypto";

export const STATE_COOKIE = "ml_oauth_state";
const VALIDADE_MS = 10 * 60 * 1000;

export interface OAuthState {
  nonce: string;
  organizationId: string;
  marketplaceId: string;
  exp: number;
}

// O estado vai cifrado no cookie (AES-GCM dá integridade junto), e só o nonce
// viaja na URL. Assim o provedor não vê organização nem canal, e um state
// forjado não passa: sem o cookie correspondente, não há o que comparar.
export function criarEstado(organizationId: string, marketplaceId: string) {
  const estado: OAuthState = {
    nonce: randomUUID(), organizationId, marketplaceId, exp: Date.now() + VALIDADE_MS,
  };
  return { nonce: estado.nonce, cookie: encryptSecret(JSON.stringify(estado)) };
}

function mesmoNonce(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function lerEstado(cookie: string, nonceRecebido: string): OAuthState {
  let estado: OAuthState;
  try {
    estado = JSON.parse(decryptSecret(cookie));
  } catch {
    throw new OrderError("Estado de autorização inválido.");
  }
  if (!estado?.nonce || !estado.organizationId || !estado.marketplaceId || typeof estado.exp !== "number") {
    throw new OrderError("Estado de autorização inválido.");
  }
  if (!mesmoNonce(estado.nonce, nonceRecebido)) throw new OrderError("Estado de autorização não corresponde.");
  if (estado.exp <= Date.now()) throw new OrderError("Autorização expirada. Repita o processo.");
  return estado;
}
