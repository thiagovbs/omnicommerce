import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { compare } from "bcryptjs";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Senha", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const user = await prisma.user.findUnique({
          where: { email: credentials.email as string },
        });

        if (!user || !user.passwordHash) return null;

        const isPasswordValid = await compare(
          credentials.password as string,
          user.passwordHash
        );

        if (!isPasswordValid) return null;

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          organizationId: user.organizationId,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id; // Garante que o ID do usuário está no token
        token.organizationId = (user as any).organizationId;
        token.role = (user as any).role;
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        (session.user as any).id = token.id;
        (session.user as any).organizationId = token.organizationId;
        (session.user as any).role = token.role;
      }
      return session;
    },
  },
  
  events: {
    async signIn({ user }) {
      try {
        if (user && user.id) {
          // Buscamos a organização do usuário diretamente, já que o objeto 'user' do evento pode vir limitado
          const dbUser = await prisma.user.findUnique({
            where: { id: user.id },
            select: { organizationId: true, name: true, email: true }
          });

          if (dbUser) {
            await prisma.auditLog.create({
              data: {
                action: "LOGIN",
                entity: "USER",
                entityId: user.id,
                details: `Usuário ${dbUser.name || dbUser.email} efetuou login no sistema com sucesso.`,
                oldData: {},
                newData: { 
                  loginAt: new Date(),
                  email: dbUser.email 
                },
                userId: user.id,
                organizationId: dbUser.organizationId,
              },
            });
            console.log(`📝 [AUDIT]: Login registrado para o usuário ${user.id}`);
          }
        }
      } catch (error) {
        console.error("❌ Erro crítico ao registrar auditoria de login:", error);
      }
    },
  },
  session: { strategy: "jwt" },
});