import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * F4: registration must close once this instance has an owner.
 *
 * Linki is single-tenant and self-hosted. The signup route stayed open forever,
 * gated only by an invite code that IS `AUTH_PASSWORD` — the same secret used to
 * log in. So anyone who learned the login password could also mint additional
 * accounts, and every account has full access to the LinkedIn sessions, the
 * message bodies, and the target lists.
 *
 * "You already need the password" is not a defence. A password is for
 * authenticating the owner; it is not an authorisation to create new owners, and
 * a second account is far quieter than a login — nothing in the UI surfaces it.
 */

const dbDir = mkdtempSync(join(tmpdir(), "linki-signup-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-signup-tests";
process.env.AUTH_PASSWORD = "the-invite-code-and-login-password";

// bcrypt is mocked so "did it hash?" is COUNTED, not timed. The first version of
// the last test asserted wall-clock < 60ms; bcryptjs cost 10 measures ~53ms on
// this machine, so a mutation that added a full hash before the guard slipped
// under the threshold and survived. A timing assertion on a 7ms margin is not a
// test, it is a coin flip.
let hashCalls = 0;
const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { exports: Record<string, unknown> }) => void;
const fakeBcrypt = {
  async hash() { hashCalls++; return "$2a$10$fakehashfortests"; },
  async compare() { return false; },
};
mockModule("bcryptjs", { exports: { default: fakeBcrypt, ...fakeBcrypt } });

const { default: signup } = await import("@/pages/api/auth/signup");
const { getDb } = await import("@/lib/db");
const db = getDb();

after(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dbDir, { recursive: true, force: true });
});

interface Captured { status: number; body: unknown }

async function post(body: unknown): Promise<Captured> {
  const cap: Captured = { status: 200, body: undefined };
  const res = {
    status(c: number) { cap.status = c; return this; },
    json(b: unknown) { cap.body = b; return this; },
    end() { return this; },
  };
  await signup(
    // Distinct IPs so the route's own per-IP rate limiter never becomes the
    // reason a test passes — that would hide the behaviour under test.
    { method: "POST", body, headers: { "x-forwarded-for": `10.0.0.${++ip}` }, socket: {} } as never,
    res as never
  );
  return cap;
}
let ip = 0;

const users = () => (db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c;

test("F4: the FIRST signup succeeds — a fresh instance can still be claimed", async () => {
  assert.equal(users(), 0, "precondition: no owner yet");
  const r = await post({
    email: "owner@example.invalid",
    password: "a-long-enough-password",
    inviteCode: "the-invite-code-and-login-password",
  });
  assert.equal(r.status, 201, `expected 201, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(users(), 1);
  assert.equal(hashCalls, 1, "and the one legitimate signup DID hash its password");
});

test("F4 repro: a SECOND signup is refused with 403", async () => {
  assert.equal(users(), 1, "precondition: an owner exists");
  const r = await post({
    email: "intruder@example.invalid",
    password: "a-long-enough-password",
    inviteCode: "the-invite-code-and-login-password",
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(users(), 1, "and no second user was created");
});

test("F4: refused even with a VALID invite code — this is not an auth failure", async () => {
  // The distinction that makes the fix meaningful. A wrong code already produced
  // 403. If the closed-registration 403 only appeared for a WRONG code, the
  // route would still be open to anyone holding the password — which is exactly
  // the population the change exists to stop.
  const valid = await post({
    email: "second@example.invalid",
    password: "a-long-enough-password",
    inviteCode: process.env.AUTH_PASSWORD,
  });
  assert.equal(valid.status, 403);
  assert.match(String((valid.body as { error?: string }).error), /registration is closed/i,
    "and it must SAY registration is closed, not 'invalid invite code' — an operator " +
    "who mistypes nothing should not be sent hunting for a wrong secret");
  assert.equal(users(), 1);
});

test("F4: the refusal precedes any password hashing or write", async () => {
  // A closed route that still hashes is a free CPU-exhaustion primitive for
  // anyone who can reach it — bcrypt cost 10 is ~53ms of pure CPU here, and the
  // rate limiter allows 10 attempts per window before it engages.
  const before = users();
  const hashesBefore = hashCalls;

  const r = await post({
    email: "flood@example.invalid",
    password: "a-long-enough-password",
    inviteCode: "wrong-code-entirely",
  });

  assert.equal(r.status, 403);
  assert.equal(users(), before, "no write");
  assert.equal(hashCalls, hashesBefore,
    "bcrypt must never be reached once registration is closed — counted, not timed");
});
