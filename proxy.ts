import { auth } from "@/lib/auth";

// Renomeado de middleware.ts (convenção depreciada no Next.js 16). Proxy roda
// obrigatoriamente no runtime Node.js, o que também torna seguro o import de lib/auth.
export const proxy = auth((req) => {
  const isLoggedIn = !!req.auth;
  const { nextUrl } = req;

  // Se o usuário tentar acessar a raiz "/", mande para o dashboard
  if (nextUrl.pathname === "/") {
    return Response.redirect(new URL("/dashboard", nextUrl));
  }

  // Proteção das rotas (protected). Toda página sob (protected) precisa estar listada:
  // sem sessão, currentActor() lança e a página responderia 500 em vez de redirecionar.
  const protectedRoutes = [
    "/dashboard", "/sales", "/users", "/marketplaces", "/organizations", "/audit", "/integrations",
    "/products",
  ];
  const isProtectedRoute = protectedRoutes.some((route) => nextUrl.pathname.startsWith(route));

  if (isProtectedRoute && !isLoggedIn) {
    return Response.redirect(new URL("/login", nextUrl));
  }

  return null;
});

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};