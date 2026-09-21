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
  /// Conta do provedor que se pretende reautorizar, quando a autorização
  /// partiu de uma conexão existente. Ausente ao conectar uma conta nova.
  ///
  /// Existe porque quem escolhe a conta é a sessão aberta NO PROVEDOR, não
  /// nós: com duas contas no mesmo canal, clicar em reautorizar uma e estar
  /// logado na outra renovava a credencial errada, calado.
  contaEsperada?: string;
  exp: number;
}

// O estado vai cifrado no cookie (AES-GCM dá integridade junto), e só o nonce
// viaja na URL. Assim o provedor não vê organização nem canal, e um state
// forjado não passa: sem o cookie correspondente, não há o que comparar.
/**
 * Confere que o provedor devolveu a conta que se pediu para reautorizar.
 *
 * Quem escolhe a conta é a sessão aberta NO PROVEDOR, não o nosso link. Com
 * duas contas no mesmo canal, reautorizar uma estando logado na outra renovava
 * a credencial errada em silêncio: a tela dizia "conectado", a conta pedida
 * continuava vencida, e a publicação ia para a conta que tinha token.
 */
export function assertContaEsperada(estado: OAuthState, contaRecebida: string) {
  if (!estado.contaEsperada || estado.contaEsperada === contaRecebida) return;
  throw new OrderError(
    `a autorização voltou da conta ${contaRecebida}, e não da conta ${estado.contaEsperada}, `
    + "que é a que você pediu para reautorizar. Saia do Mercado Livre ou use uma janela "
    + "anônima e entre com a conta certa.");
}

export function criarEstado(
  organizationId: string, marketplaceId: string, contaEsperada?: string,
) {
  const estado: OAuthState = {
    nonce: randomUUID(), organizationId, marketplaceId,
    ...(contaEsperada ? { contaEsperada } : {}),
    exp: Date.now() + VALIDADE_MS,
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
