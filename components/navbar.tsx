"use client";

import { signOut } from "next-auth/react";
import { LogOut, Menu, User as UserIcon } from "lucide-react";

/**
 * Barra de topo.
 *
 * No celular ela carrega o botão que abre o menu, que ali é gaveta. E tudo o
 * que é texto longo (nome da organização, nome da pessoa) trunca em vez de
 * empurrar: um nome comprido empurrava o cabeçalho para fora da tela e levava a
 * página junto.
 */
export function Navbar({ userName, orgName, onAbrirMenu }: {
  userName: string;
  orgName: string;
  onAbrirMenu?: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b bg-white px-4 sm:px-6 lg:px-8">
      <div className="flex min-w-0 items-center gap-2">
        {/* O botão da gaveta só existe onde o menu lateral não cabe. */}
        <button
          type="button"
          onClick={onAbrirMenu}
          className="-ml-1 rounded-lg p-2 text-gray-600 hover:bg-gray-100 lg:hidden"
          aria-label="Abrir menu"
        >
          <Menu size={20} />
        </button>
        <span className="hidden text-sm font-semibold uppercase tracking-wider text-gray-500 sm:inline">Org:</span>
        <span className="truncate text-sm font-bold text-gray-900">{orgName}</span>
      </div>

      <div className="flex shrink-0 items-center gap-3 sm:gap-6">
        <div className="flex items-center gap-2 text-sm">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-blue-700">
            <UserIcon size={16} />
          </div>
          <span className="hidden max-w-[12rem] truncate font-medium text-gray-700 md:inline">{userName}</span>
        </div>

        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex items-center gap-2 text-sm text-gray-500 transition-colors hover:text-red-600"
          aria-label="Sair"
        >
          <LogOut size={18} />
          <span className="hidden sm:inline">Sair</span>
        </button>
      </div>
    </header>
  );
}
