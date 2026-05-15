import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const { nextUrl } = req;

  // Se o usuário tentar acessar a raiz "/", mande para o dashboard
  if (nextUrl.pathname === "/") {
    return Response.redirect(new URL("/dashboard", nextUrl));
  }

  // Proteção das rotas (protected)
  const isProtectedRoute = nextUrl.pathname.startsWith("/dashboard") || 
                           nextUrl.pathname.startsWith("/sales") || 
                           nextUrl.pathname.startsWith("/users") ||
                           nextUrl.pathname.startsWith("/marketplaces");

  if (isProtectedRoute && !isLoggedIn) {
    return Response.redirect(new URL("/login", nextUrl));
  }

  return null;
});

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};