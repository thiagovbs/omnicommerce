import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell, COOKIE_MENU } from "@/components/app-shell";
import { prisma } from "@/lib/prisma";

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
    where: { id: session.user.organizationId }
  });

  // O estado do menu vem do cookie e é lido AQUI, no servidor: assim a página
  // chega pronta no tamanho escolhido. Lido no cliente, o menu apareceria
  // largo e encolheria depois, a cada navegação.
  const recolhida = (await cookies()).get(COOKIE_MENU)?.value === "1";

  // A moldura é cliente porque a gaveta tem estado; `children` continua sendo
  // renderizado no servidor e atravessa como propriedade.
  return (
    <AppShell
      userName={session.user.name || "Usuário"}
      orgName={org?.name || "Global"}
      recolhidaInicial={recolhida}
    >
      {children}
    </AppShell>
  );
}
