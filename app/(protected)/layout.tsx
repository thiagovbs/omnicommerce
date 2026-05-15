import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { Navbar } from "@/components/navbar";
import { prisma } from "@/lib/prisma";

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "OmniCommerce",
  description: "Sistema de gestão multi-marketplace",
};

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  // Buscamos o nome da organização para exibir na Navbar
  const org = await prisma.organization.findUnique({
    where: { id: (session.user as any).organizationId }
  });

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Barra Lateral Fixa */}
      <Sidebar />

      {/* Área de Conteúdo */}
      <div className="flex-1 flex flex-col">
        <Navbar 
          userName={session.user.name || "Usuário"} 
          orgName={org?.name || "Global"} 
        />
        <main className="flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}