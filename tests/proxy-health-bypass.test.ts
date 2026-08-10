import test from "node:test";
import assert from "node:assert/strict";

// T5.3 — the bypass must be EXACT. A prefix would expose /api/health-secrets;
// the pathname is already normalised when proxy() sees it, so traversal has
// resolved before comparison.

const src = await (await import("node:fs/promises")).readFile("proxy.ts", "utf8");

/** Mirrors proxy()'s decision without importing next/server. */
function bypasses(pathname: string): boolean {
  const exact = ["/api/health"];
  const prefixes = ["/api/auth/", "/api/oauth/", "/api/mcp"];
  if (!pathname.startsWith("/api/")) return true;             // not gated at all
  if (exact.includes(pathname)) return true;
  return prefixes.some(p => pathname.startsWith(p));
}

test("the exact list is an equality check, not a prefix match", () => {
  assert.match(src, /PUBLIC_API_EXACT\.includes\(pathname\)/, "must use includes(), not startsWith()");
  assert.match(src, /const PUBLIC_API_EXACT = \["\/api\/health"\]/);
  assert.doesNotMatch(src, /PUBLIC_API_EXACT\.some\(p => pathname\.startsWith/, "never a prefix");
});

test("the three pre-existing prefixes are unchanged and not widened", () => {
  assert.match(src, /const PUBLIC_API_PREFIXES = \["\/api\/auth\/", "\/api\/oauth\/", "\/api\/mcp"\]/);
});

test("/api/health bypasses; neighbours and variants do NOT", () => {
  assert.equal(bypasses("/api/health"), true, "the endpoint itself");

  for (const p of [
    "/api/health-secrets",       // prefix-collision neighbour
    "/api/healthz",              // near-miss
    "/api/health/",              // trailing slash — a different pathname
    "/api/health/sub",           // nested
    "/api/HEALTH",               // case variant
    "/api/Health",
    "/api/accounts",             // an ordinary gated route
    "/api/runs/abc",
  ]) {
    assert.equal(bypasses(p), false, `${p} must stay gated`);
  }
});

test("a query string does not change the pathname, so it neither grants nor blocks", () => {
  // proxy() reads req.nextUrl.pathname, which excludes the query. "/api/health?x=1"
  // has pathname "/api/health" — bypassed, correctly, because the route ignores
  // query params entirely and is read-only.
  assert.equal(bypasses("/api/health"), true);
  assert.match(src, /const \{ pathname \} = req\.nextUrl/, "decision is made on pathname, not the raw URL");
});

test("traversal cannot reach a gated route through the bypass", () => {
  // Next normalises before middleware, so proxy() would see "/api/accounts".
  assert.equal(bypasses("/api/accounts"), false, "the resolved path is gated");
  // And the literal, unresolved form is not in the exact list either.
  assert.equal(bypasses("/api/healthz/../accounts"), false);
});
