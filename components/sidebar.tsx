"use client";

import { useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ShoppingBag,
  Store,
  Users,
  Package,
  Building2,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from "lucide-react";
import { isOrgAdmin } from "@/lib/domain/roles";
import { cn } from "@/lib/utils";

const everyone = () => true;

const menuItems = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard, visible: everyone },
  { name: "Vendas", href: "/sales", icon: ShoppingBag, visible: everyone },
  { name: "Produtos", href: "/products", icon: Package, visible: everyone },
  { name: "Marketplaces", href: "/marketplaces", icon: Store, visible: everyone },
  { name: "Integrações", href: "/integrations", icon: History, visible: isOrgAdmin },
  { name: "Equipe", href: "/users", icon: Users, visible: isOrgAdmin },
  { name: "Organizações", href: "/organizations", icon: Building2, visible: isOrgAdmin },
  { name: "Auditoria", href: "/audit", icon: History, visible: isOrgAdmin },
];

/**
 * Menu lateral, em três estados.
 *
 * - **Celular:** gaveta. Fica fora da tela e entra por cima, porque 256 px de
 *   menu fixo numa tela de 375 deixavam 119 px para o conteúdo -- largura em
 *   que nenhuma tabela cabe.
 * - **Desktop, aberto:** ícone e rótulo, como sempre foi.
 * - **Desktop, recolhido:** só os ícones, 64 px. Devolve 192 px de largura para
 *   a tabela sem tirar a navegação do alcance de um clique, que é o que se
 *   perderia se o menu sumisse por inteiro.
 *
 * Recolhido, cada item mantém `title` e `aria-label`: sem o rótulo visível, o
 * ícone sozinho não diz para onde leva -- nem para quem usa leitor de tela.
 */
export function Sidebar({ aberta = false, recolhida = false, onFechar, onAlternarRecolhida }: {
  aberta?: boolean;
  recolhida?: boolean;
  onFechar?: () => void;
  onAlternarRecolhida?: () => void;
}) {
  const pathname = usePathname();
  const { data: session, status } = useSession();

  // O esqueleto só ocupa espaço onde o menu é fixo; no celular ele não existe,
  // senão rouba a largura da tela enquanto a sessão carrega. E respeita o
  // estado recolhido, para a tela não dar um salto quando a sessão chega.
  if (status === "loading") {
    return <div className={cn("hidden bg-slate-900 lg:block", recolhida ? "w-16" : "w-64")} />;
  }

  const userRole = (session?.user as { role?: string } | undefined)?.role;
  // Na gaveta o menu está sempre por extenso: ali o espaço é a tela inteira, e
  // recolher não devolveria nada.
  const soIcones = recolhida;

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-40 flex h-screen flex-col bg-slate-900 text-slate-300",
        "transition-all duration-200 lg:sticky lg:top-0 lg:translate-x-0",
        aberta ? "translate-x-0" : "-translate-x-full",
        // A largura recolhida vale só a partir de `lg`: no celular a gaveta é
        // sempre larga, porque lá ela cobre a tela em vez de dividi-la.
        recolhida ? "w-64 lg:w-16" : "w-64",
      )}
    >
      <div className={cn(
        "flex items-center gap-2 p-6 text-white",
        soIcones ? "lg:justify-center lg:px-3" : "justify-between",
      )}>
        <div className="flex min-w-0 items-center gap-3">
          <Package className="shrink-0 text-blue-400" size={32} />
          <span className={cn(
            "truncate text-xl font-bold tracking-tight",
            soIcones && "lg:hidden",
          )}>
            OmniCommerce
          </span>
        </div>

        {/* Fecha a gaveta: só no celular. */}
        <button
          type="button"
          onClick={onFechar}
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white lg:hidden"
          aria-label="Fechar menu"
        >
          <X size={20} />
        </button>

        {/* Recolhe/expande: só onde o menu divide a tela com o conteúdo. */}
        <button
          type="button"
          onClick={onAlternarRecolhida}
          className={cn(
            "hidden rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white lg:block",
            soIcones && "lg:hidden",
          )}
          aria-label="Recolher menu"
          aria-expanded={!recolhida}
          title="Recolher menu"
        >
          <PanelLeftClose size={20} />
        </button>
      </div>

      <nav className={cn("flex-1 space-y-1 px-4", soIcones && "lg:px-2")}>
        {menuItems.map((item) => {
          // Cosmetic only: every route and action authorizes again on the server.
          if (!item.visible(userRole)) return null;
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              // Navegou pela gaveta: ela se fecha. Sem isto ela fica aberta por
              // cima da tela nova, e é preciso fechá-la para ver o que se pediu.
              onClick={onFechar}
              title={soIcones ? item.name : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 transition-colors",
                soIcones && "lg:justify-center lg:px-2",
                isActive
                  ? "bg-blue-600 text-white"
                  : "hover:bg-slate-800 hover:text-white",
              )}
            >
              <item.icon size={20} className="shrink-0" />
              {/* Recolhido, o rótulo sai da vista mas continua no acessível:
                  `sr-only` mantém o nome para o leitor de tela. */}
              <span className={cn("truncate font-medium", soIcones && "lg:sr-only")}>
                {item.name}
              </span>
            </Link>
          );
        })}
      </nav>

      <div className={cn(
        "border-t border-slate-800 p-4 text-xs text-slate-500",
        soIcones && "lg:flex lg:justify-center lg:p-2",
      )}>
        {/* Recolhido, o rodapé vira o botão de expandir: é o lugar onde a mão
            já está, e sem ele não haveria como trazer o menu de volta. */}
        <button
          type="button"
          onClick={onAlternarRecolhida}
          className={cn(
            "hidden rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white",
            soIcones && "lg:block",
          )}
          aria-label="Expandir menu"
          aria-expanded={false}
          title="Expandir menu"
        >
          <PanelLeftOpen size={20} />
        </button>
        <span className={cn(soIcones && "lg:hidden")}>v2.0.0-standalone</span>
      </div>
    </aside>
  );
}
