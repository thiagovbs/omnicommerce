"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteUser } from "./actions";

export function DeleteUserButton({ userId, userName }: { userId: string; userName: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function remove() {
    if (!confirm(`Excluir ${userName}?`)) return;
    setPending(true);
    setError("");
    try {
      const result = await deleteUser(userId);
      if (!result.ok) setError(result.error);
      router.refresh();
    } catch { setError("Falha de comunicação. Tente novamente."); }
    finally { setPending(false); }
  }

  return (
    <div className="flex flex-col items-end">
      <button
        onClick={remove}
        disabled={pending}
        aria-label={`Excluir ${userName}`}
        className="text-gray-400 hover:text-red-600 transition-colors disabled:opacity-50"
      >
        <Trash2 size={18} />
      </button>
      {error && <p role="alert" className="mt-1 max-w-xs text-xs text-red-600">{error}</p>}
    </div>
  );
}
