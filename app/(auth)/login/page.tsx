"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const formData = new FormData(e.currentTarget);

    try {
      // redirect: false mantém o erro nesta página em vez de devolver o
      // usuário à página interna do Auth.js.
      const result = await signIn("credentials", {
        email: formData.get("email"),
        password: formData.get("password"),
        redirect: false,
      });
      if (!result || result.error) {
        setError("E-mail ou senha incorretos.");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Não foi possível entrar. Tente novamente.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100">
      <form onSubmit={handleSubmit} className="bg-white p-8 rounded-xl shadow-md w-full max-w-sm">
        <h1 className="text-2xl font-bold mb-6">Omnicommerce Login</h1>
        <div className="space-y-4">
          <input name="email" type="email" placeholder="Email" autoComplete="username" className="w-full p-2 border rounded" required />
          <input name="password" type="password" placeholder="Senha" autoComplete="current-password" className="w-full p-2 border rounded" required />
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={loading} className="w-full bg-blue-600 text-white p-2 rounded hover:bg-blue-700 disabled:opacity-50">
            {loading ? "Entrando..." : "Entrar"}
          </button>
        </div>
      </form>
    </div>
  );
}
