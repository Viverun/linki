import NextAuth, { type NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { getDb } from "@/lib/db";
import { isRateLimited } from "@/lib/rate-limit";
import { getSessionUser } from "@/lib/auth";

declare module "next-auth" {
  interface User {
    sessionVersion?: number;
  }
}

type UserRow = { id: string; email: string; password_hash: string; session_version: number };

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) return null;

        // Throttle login attempts per IP — this is the password brute-force surface.
        if (isRateLimited(req, "login", 10, 15 * 60 * 1000)) {
          throw new Error("Too many attempts. Try again later.");
        }

        const db = getDb();
        const user = db
          .prepare("SELECT id, email, password_hash, session_version FROM users WHERE email = ?")
          .get(credentials.email) as UserRow | undefined;

        if (!user) return null;

        const valid = await compare(credentials.password, user.password_hash);
        if (!valid || !getSessionUser({ sub: user.id, sessionVersion: user.session_version })) return null;

        return { id: user.id, email: user.email, sessionVersion: user.session_version };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.sessionVersion = user.sessionVersion;
      }
      if (!getSessionUser(token)) throw new Error("Session revoked");
      return token;
    },
    async session({ session, token }) {
      const user = getSessionUser(token);
      if (!user) throw new Error("Session revoked");
      session.user = { ...session.user, email: user.email };
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  secret: process.env.NEXTAUTH_SECRET,
};

export default NextAuth(authOptions);
