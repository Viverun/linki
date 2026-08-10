import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/auth";

// Routes that manage their own complete auth flow and must not be pre-empted by a
// generic 401 here — every one of them either issues/discovers credentials (not a
// resource to protect) or has its own response contract an upstream 401 would break.
//
//  - /api/auth/*                    NextAuth's own login/session/csrf machinery.
//  - /api/oauth/authorize           Manages its own getServerSession + redirect-to-/login;
//                                   a blanket 401 here would break that browser flow.
//  - /api/oauth/token, /register    Server-to-server OAuth token exchange / dynamic client
//                                   registration — no user session exists at this step.
//  - /api/oauth/metadata-*          RFC 8414/9728 discovery documents, fetched before any
//                                   auth exists by design.
//  - /api/mcp                       Verifies its own Bearer token (lib/premium.ts boundary —
//                                   this file can't import that ee-only check) and, on
//                                   failure, must reply with a WWW-Authenticate header
//                                   pointing at OAuth discovery (RFC 9728) so MCP clients
//                                   can bootstrap the auth flow. A generic 401 here would
//                                   swallow that header and break every MCP client's first
//                                   connection attempt.
const PUBLIC_API_PREFIXES = ["/api/auth/", "/api/oauth/", "/api/mcp"];

// EXACT path, never a prefix. A prefix would expose anything beginning with the
// same characters (/api/health-secrets), and the check runs against the already-
// normalised pathname so traversal (/api/healthz/../accounts) has resolved before
// it is compared. Checked ahead of the prefix list purely for clarity; it is an
// equality test and cannot widen those prefixes.
//
// Unauthenticated because a container healthcheck has no session. Safe because
// the route is read-only, performs no COUNT over data, and returns no counts,
// identifiers, env values, or error messages — only a state and an error class.
const PUBLIC_API_EXACT = ["/api/health"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (!pathname.startsWith("/api/")) return NextResponse.next();
  if (PUBLIC_API_EXACT.includes(pathname)) return NextResponse.next();
  if (PUBLIC_API_PREFIXES.some(p => pathname.startsWith(p))) return NextResponse.next();

  const authed = await isAuthenticated(req);
  if (!authed) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
