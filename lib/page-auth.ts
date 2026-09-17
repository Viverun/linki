import type { GetServerSidePropsContext } from "next";
import { getToken } from "next-auth/jwt";
import { getSessionUser } from "@/lib/auth";

export async function requirePageSession(ctx: GetServerSidePropsContext) {
  try {
    const token = await getToken({ req: ctx.req, secret: process.env.NEXTAUTH_SECRET });
    if (getSessionUser(token)) return null;
  } catch {
    return { redirect: { destination: "/login", permanent: false } as const };
  }
  return { redirect: { destination: "/login", permanent: false } as const };
}
