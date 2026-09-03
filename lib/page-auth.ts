import type { GetServerSidePropsContext } from "next";
import { getToken } from "next-auth/jwt";

/**
 * Phase 0: fail-closed SSR page guard.
 *
 * Every page with getServerSideProps queries the DB directly (bypassing
 * proxy.ts, which only gates /api/*) and embeds rows in SSR HTML. The
 * client-side AuthGuard in pages/_app.tsx hides UI but `curl <page>` still
 * executes SSR. Call this first in getServerSideProps; if it returns
 * non-null, return it immediately (redirect to /login).
 *
 * Uses getToken (not getServerSession + authOptions) deliberately: it asks
 * the same question lib/auth.ts asks the edge gate — "is there a session
 * JWT for NEXTAUTH_SECRET?" — without importing the [...nextauth] route
 * module into every SSR page.
 */
export async function requirePageSession(ctx: GetServerSidePropsContext) {
  const token = await getToken({ req: ctx.req, secret: process.env.NEXTAUTH_SECRET });
  if (!token?.email) {
    return { redirect: { destination: "/login", permanent: false } as const };
  }
  return null;
}
