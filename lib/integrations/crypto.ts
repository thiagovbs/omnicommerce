import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class SecretConfigurationError extends Error { override name = "SecretConfigurationError"; }

function key() {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!raw) throw new SecretConfigurationError("Chave de criptografia de integração ausente.");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new SecretConfigurationError("Chave de criptografia de integração inválida.");
  return bytes;
}

// AES-256-GCM, armazenado como base64 de iv(12) | authTag(16) | ciphertext.
export function encryptSecret(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decryptSecret(value: string) {
  const raw = Buffer.from(value, "base64");
  if (raw.length <= 28) throw new SecretConfigurationError("Segredo armazenado inválido.");
  const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
