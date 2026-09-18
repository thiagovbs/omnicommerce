import type { Metadata } from "next";

// A página de login é client component e não pode exportar metadata;
// o título dela vive aqui.
export const metadata: Metadata = {
  title: "Entrar",
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
