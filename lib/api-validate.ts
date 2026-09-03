import type { NextApiResponse } from "next";

/**
 * Phase 2: shared API input guards.
 *
 * Most routes validated with truthy-only checks (`if (!x)`), which lets
 * wrong-shaped input through to SQL (`Number("abc")` → NaN → 500) or
 * through `.map()` (a string has `.length`, then throws). These helpers
 * are the single definition of the common shapes; routes already using
 * stricter checks (runs/[id]/retry.ts, workflows PUT steps via zod) are
 * unchanged.
 */

/** 405 with an Allow header (the repo was split ~60/40 on the header). */
export function methodNotAllowed(res: NextApiResponse, allowed: string[]) {
  res.setHeader("Allow", allowed);
  return res.status(405).end();
}

/** Non-empty array of strings. Rejects `"abc"` (truthy .length, then .map throws). */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(t => typeof t === "string");
}

/**
 * Safe LIMIT/OFFSET from query params. Garbage (`page=abc`, `limit=-5`)
 * used to reach SQL as NaN/negative and throw → 500. Clamped ints instead.
 */
export function pageParams(
  query: { page?: unknown; limit?: unknown },
  defaults: { page?: number; limit?: number; maxLimit?: number } = {}
): { limit: number; offset: number } {
  const { page: defaultPage = 0, limit: defaultLimit = 50, maxLimit = 500 } = defaults;
  const toInt = (v: unknown, fallback: number): number => {
    const n = typeof v === "string" ? Number(v) : NaN;
    return Number.isInteger(n) ? n : fallback;
  };
  const page = Math.max(0, toInt(query.page, defaultPage));
  const limit = Math.min(maxLimit, Math.max(1, toInt(query.limit, defaultLimit)));
  return { limit, offset: page * limit };
}
