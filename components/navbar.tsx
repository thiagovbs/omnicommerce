"use client";

import { signOut } from "next-auth/react";
import { LogOut, User as UserIcon } from "lucide-react";

export function Navbar({ userName, orgName }: { userName: string, orgName: string }) {
  return (
    <header className="h-16 border-b bg-white flex items-center justify-between px-8 sticky top-0 z-30">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Org:</span>
        <span className="text-sm font-bold text-gray-900">{orgName}</span>
      </div>

      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2 text-sm">
          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700">
            <UserIcon size={16} />
          </div>
          <span className="font-medium text-gray-700">{userName}</span>
        </div>

        <button 
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex items-center gap-2 text-sm text-gray-500 hover:text-red-600 transition-colors"
        >
          <LogOut size={18} />
          Sair
        </button>
      </div>
    </header>
  );
}