"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { sincronizarIntegracoes } from "./actions";

/**
 * Sincroniza uma conta, ou todas quando não recebe `connectionId`.
 *
 * O resumo fica na tela depois de rodar porque "nada aconteceu" e "não havia
 * nada a trazer" são estados diferentes, e sem o número eles são iguais aos
 * olhos de quem apertou.
 */
export function SyncButton(
  { connectionId, label = "Sincronizar agora", destaque = false }:
  { connectionId?: string; label?: string; destaque?: boolean },
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [resumo, setResumo] = useState("");
  const router = useRouter();

  async function sincronizar() {
    setPending(true);
    setError("");
    setResumo("");
    try {
      const result = await sincronizarIntegracoes(connectionId);
      if (!result.ok) setError(result.error);
      else {
        const { verificados, enfileirados, publicados, falhas } = result.resultado;
        setResumo(enfileirados || publicados
          // As vendas não aparecem no mesmo instante: o aviso publicado ainda
          // passa pelo trabalhador. Dizer isso evita o segundo clique.
          ? `${enfileirados} aviso(s) na fila, ${publicados} publicado(s).`
            + " As vendas entram em alguns segundos."
          : `Nada novo: ${verificados} pedido(s) conferido(s), todos já em dia.`);
        if (falhas.length) setError(falhas.join(" | "));
      }
      router.refresh();
    } catch { setError("Falha de comunicação. Tente novamente."); }
    finally { setPending(false); }
  }

  return <div>
    <button
      onClick={sincronizar}
      disabled={pending}
      className={destaque
        ? "rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        : "rounded border px-3 py-1 text-sm disabled:opacity-50"}
    >
      {pending ? "Sincronizando..." : label}
    </button>
    {resumo && <p className="mt-1 text-xs text-gray-600">{resumo}</p>}
    {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
  </div>;
}
