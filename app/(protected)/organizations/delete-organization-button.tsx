"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteOrganization } from "./actions";

export function DeleteOrganizationButton({
  organizationId, organizationName,
}: { organizationId: string; organizationName: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function remove() {
    if (!confirm("Excluir a organização " + organizationName + "?")) return;
    setPending(true);
    setError("");
    try {
      const result = await deleteOrganization(organizationId);
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
        aria-label={"Excluir " + organizationName}
        className="p-2 text-gray-400 hover:text-red-600 disabled:opacity-50"
      >
        <Trash2 size={18} />
      </button>
      {error && <p role="alert" className="mt-1 max-w-xs text-xs text-red-600">{error}</p>}
    </div>
  );
}
