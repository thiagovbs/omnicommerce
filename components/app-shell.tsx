"use client";

import { useEffect, useState } from "react";
import { Navbar } from "./navbar";
import { Sidebar } from "./sidebar";

/// Onde a escolha de recolher o menu fica guardada. Cookie, e não
/// `localStorage`, porque o servidor lê cookie: a página já chega renderizada
/// no estado certo, sem o menu aparecer largo e encolher depois.
export const COOKIE_MENU = "menu-recolhido";

/**
 * Moldura das telas autenticadas: barra lateral, topo e conteúdo.
 *
 * Existe porque a barra lateral tem estado -- gaveta no celular, recolhida ou
 * não no desktop -- e quem a comanda são botões que moram no topo e nela
 * mesma. O layout continua sendo servidor; só esta casca é cliente, e
 * `children` atravessa como propriedade, sem virar cliente junto.
 *
 * `min-w-0` na coluna de conteúdo é o conserto do defeito que se via no
 * celular: num flex container, o filho tem `min-width: auto` e NÃO encolhe
 * abaixo do conteúdo. Então uma tabela larga esticava a coluna, a página
 * inteira ganhava rolagem horizontal, e o cartão branco -- que para na largura
 * da tela -- ficava menor que a tabela dentro dele. Era o "conteúdo estourando
 * o fundo". Com `min-w-0` a coluna encolhe, e a rolagem passa a acontecer
 * dentro de cada tabela, que é onde ela pertence.
 */
export function AppShell({
  userName, orgName, recolhidaInicial = false, children,
}: {
  userName: string;
  orgName: string;
  recolhidaInicial?: boolean;
  children: React.ReactNode;
}) {
  const [menuAberto, setMenuAberto] = useState(false);
  const [recolhida, setRecolhida] = useState(recolhidaInicial);

  // Enquanto a gaveta está aberta, o fundo não rola atrás dela.
  useEffect(() => {
    if (!menuAberto) return;
    const anterior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = anterior; };
  }, [menuAberto]);

  const alternarRecolhida = () => {
    const proxima = !recolhida;
    setRecolhida(proxima);
    // Um ano, e em todo o site: a escolha do tamanho do menu é da pessoa, não
    // da sessão. `SameSite=Lax` porque nada aqui é enviado em requisição de
    // terceiro.
    document.cookie =
      `${COOKIE_MENU}=${proxima ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar
        aberta={menuAberto}
        recolhida={recolhida}
        onFechar={() => setMenuAberto(false)}
        onAlternarRecolhida={alternarRecolhida}
      />

      {/* Véu da gaveta: só existe no celular, e fechar tocando fora dela é o
          gesto que todo mundo tenta primeiro. */}
      {menuAberto && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/60 lg:hidden"
          onClick={() => setMenuAberto(false)}
          aria-hidden="true"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Navbar
          userName={userName}
          orgName={orgName}
          onAbrirMenu={() => setMenuAberto(true)}
        />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
