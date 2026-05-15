"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

export default function LoginPage() {
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    const formData = new FormData(e.currentTarget);
    
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      callbackUrl: "/dashboard",
    });
    setLoading(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100">
      <form onSubmit={handleSubmit} className="bg-white p-8 rounded-xl shadow-md w-full max-w-sm">
        <h1 className="text-2xl font-bold mb-6">Omnicommerce Login</h1>
        <div className="space-y-4">
          <input name="email" type="email" placeholder="Email" className="w-full p-2 border rounded" required />
          <input name="password" type="password" placeholder="Senha" className="w-full p-2 border rounded" required />
          <button type="submit" disabled={loading} className="w-full bg-blue-600 text-white p-2 rounded hover:bg-blue-700">
            {loading ? "Entrando..." : "Entrar"}
          </button>
        </div>
      </form>
    </div>
  );
}