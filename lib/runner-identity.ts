import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Runner identity (C2-B1 / PR-09).
 *
 * A dependency-free leaf, deliberately outside lib/linkedin/: pages/api/health.ts
 * must stay isolated from the subsystem it judges (see tests/health-isolation.test.ts
 * and the ISOLATION INVARIANT documented there), but it still needs to know whose
 * lease it is reading — RUNNER_OWNER identifies THIS process, and parseRunnerLease
 * decodes the stored lease value, without either endpoint importing anything from
 * lib/linkedin/lease.ts (or the playwright/nodemailer/etc. graph that pulls in).
 */
export const RUNNER_OWNER = `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;

/** Validates and decodes a stored lease value. Any malformed value is treated as absent. */
export function parseRunnerLease(value: string | null | undefined): { owner: string; expires_at: string } | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as { owner?: unknown; expires_at?: unknown };
    if (typeof v.owner !== "string" || typeof v.expires_at !== "string" || Number.isNaN(Date.parse(v.expires_at))) return null;
    return { owner: v.owner, expires_at: v.expires_at };
  } catch { return null; }
}
