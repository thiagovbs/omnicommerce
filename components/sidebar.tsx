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
  History 
} from "lucide-react";
import { cn } from "@/lib/utils";

const menuItems = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard, adminOnly: false },
  { name: "Vendas", href: "/sales", icon: ShoppingBag, adminOnly: false },
  { name: "Marketplaces", href: "/marketplaces", icon: Store, adminOnly: false },
  { name: "Equipe", href: "/users", icon: Users, adminOnly: true },
  { name: "Organizações", href: "/organizations", icon: Building2, adminOnly: true }, 
  { name: "Auditoria", href: "/audit", icon: History, adminOnly: true },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();

  if (status === "loading") return <div className="w-64 bg-slate-900" />;

  const userRole = (session?.user as any)?.role;

  return (
    <aside className="w-64 bg-slate-900 text-slate-300 flex flex-col h-screen sticky top-0">
      <div className="p-6 flex items-center gap-3 text-white">
        <Package className="text-blue-400" size={32} />
        <span className="text-xl font-bold tracking-tight">OmniCommerce</span>
      </div>

      <nav className="flex-1 px-4 space-y-1">
        {menuItems.map((item) => {
          if (item.adminOnly && userRole !== "ADMIN") return null;
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg transition-colors",
                isActive 
                  ? "bg-blue-600 text-white" 
                  : "hover:bg-slate-800 hover:text-white"
              )}
            >
              <item.icon size={20} />
              <span className="font-medium">{item.name}</span>
            </Link>
          );
        })}
      </nav>
      
      <div className="p-4 border-t border-slate-800 text-xs text-slate-500">
        v2.0.0-standalone
      </div>
    </aside>
  );
}