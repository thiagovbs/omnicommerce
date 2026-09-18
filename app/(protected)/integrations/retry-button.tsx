"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { retryEvent } from "./actions";

export function RetryButton({ eventId }: { eventId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  async function retry() {
    setPending(true);
    setError("");
    try {
      const result = await retryEvent(eventId);
      if (!result.ok) setError(result.error);
      router.refresh();
    } catch { setError("Falha de comunicação. Tente novamente."); }
    finally { setPending(false); }
  }
  return <div>
    <button onClick={retry} disabled={pending} className="rounded border px-3 py-1 text-sm disabled:opacity-50">{pending ? "Agendando..." : "Reprocessar"}</button>
    {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
  </div>;
}
