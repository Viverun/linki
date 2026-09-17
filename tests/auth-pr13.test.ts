import test, { after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JWT } from "next-auth/jwt";
import type { CredentialsConfig } from "next-auth/providers/credentials";
import { hash as realHash, compare as realCompare } from "bcryptjs";

const dir = mkdtempSync(join(tmpdir(), "linki-pr13-auth-"));
const overrides = {
  LINKI_DB_PATH: join(dir, "fixture.db"),
  NEXTAUTH_SECRET: "pr13-synthetic-session-secret",
  AUTH_PASSWORD: "pr13-synthetic-invite",
  INTERNAL_API_SECRET: "pr13-synthetic-service-secret",
};
const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
Object.assign(process.env, overrides);
const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { namedExports: Record<string, unknown>; defaultExport?: unknown }) => void;
mockModule("@/lib/update-check", { namedExports: { scheduleUpdateCheck() {} } });
let tokenValue: JWT | null = null;
let tokenError = false;
mockModule("next-auth/jwt", { namedExports: {
  async getToken() {
    if (tokenError) throw new Error("synthetic token failure");
    return tokenValue;
  },
} });
mockModule("next-auth", { namedExports: {}, defaultExport: () => () => undefined });
mockModule("next-auth/providers/credentials", { namedExports: {}, defaultExport: (config: unknown) => config });
let hashBarrier: (() => Promise<void>) | undefined;
let hashCalls = 0;
mockModule("bcryptjs", { namedExports: {
  compare: realCompare,
  async hash(password: string, rounds: number) {
    hashCalls++;
    await hashBarrier?.();
    return realHash(password, rounds);
  },
} });
const { getDb } = await import("@/lib/db");
const { authOptions } = await import("@/pages/api/auth/[...nextauth]");
const { default: signup } = await import("@/pages/api/auth/signup");
const { default: changePassword } = await import("@/pages/api/auth/change-password");
const { requirePageSession } = await import("@/lib/page-auth");
const { isAuthenticated } = await import("@/lib/auth");
const db = getDb();
after(() => {
  db.close();
  mock.restoreAll();
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
beforeEach(() => {
  db.exec("DELETE FROM users");
  tokenValue = null;
  tokenError = false;
  hashBarrier = undefined;
  hashCalls = 0;
});
let ip = 0;
async function post(handler: typeof signup, body: unknown) {
  const captured = { status: 200, body: undefined as unknown };
  await handler({ method: "POST", body, headers: { "x-forwarded-for": `192.0.2.${++ip}` } } as never, {
    status(status: number) { captured.status = status; return this; },
    json(body: unknown) { captured.body = body; return this; },
  } as never);
  return captured;
}
const signupBody = (email = "owner@example.invalid") => ({
  email, password: "original-password", inviteCode: overrides.AUTH_PASSWORD,
});
async function login(password = "original-password", email = "owner@example.invalid") {
  const provider = authOptions.providers[0] as CredentialsConfig;
  return provider.authorize({ email, password }, { headers: { "x-forwarded-for": `192.0.2.${++ip}` } } as never);
}
async function issueToken(password = "original-password") {
  const user = await login(password);
  assert.ok(user);
  return authOptions.callbacks!.jwt!({ token: { email: user.email }, user, trigger: "signIn" } as never);
}
async function api(internal?: string) {
  return isAuthenticated({ headers: new Headers(internal ? { "x-internal-secret": internal } : {}) } as never);
}
async function assertAccess(allowed: boolean) {
  assert.equal(await api(), allowed);
  assert.deepEqual(await requirePageSession({ req: {}, res: {} } as never),
    allowed ? null : { redirect: { destination: "/login", permanent: false } });
}
function barrier(count: number) {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return async () => {
    if (++arrived === count) release();
    await ready;
  };
}

test("PR13: fresh credentials authorize API and SSR; password change revokes all old sessions", async () => {
  assert.equal((await post(signup, signupBody())).status, 201);
  assert.equal(await login("wrong-password"), null);
  const first = await issueToken();
  const second = await issueToken();
  assert.equal(first.sessionVersion, 0);
  tokenValue = first;
  await assertAccess(true);
  assert.equal((await post(changePassword, { currentPassword: "original-password", newPassword: "replacement-password" })).status, 200);
  for (const stale of [first, second]) {
    tokenValue = stale;
    await assertAccess(false);
    assert.equal((await post(changePassword, { currentPassword: "replacement-password", newPassword: "another-password" })).status, 401);
    await assert.rejects(async () => authOptions.callbacks!.jwt!({ token: stale, trigger: "update", session: { sessionVersion: 1 } } as never), /Session revoked/);
    await assert.rejects(async () => authOptions.callbacks!.session!({ session: { user: { email: stale.email }, expires: "future" }, token: stale } as never), /Session revoked/);
  }
  assert.equal(await login(), null);
  tokenValue = await issueToken("replacement-password");
  assert.equal(tokenValue.sessionVersion, 1);
  await assertAccess(true);
  const session = await authOptions.callbacks!.session!({ session: { expires: "future" }, token: tokenValue } as never);
  assert.equal(session.user?.email, "owner@example.invalid");
});

test("PR13: missing, malformed and legacy claims fail closed on API, SSR and password route", async () => {
  await post(signup, signupBody());
  const valid = await issueToken();
  const tokens = [null, {}, { email: valid.email }, { sub: valid.sub },
    { sub: "missing-user", sessionVersion: 0 }, { sessionVersion: 0 },
    { ...valid, sessionVersion: "0" }, { ...valid, sessionVersion: -1 },
    { ...valid, sessionVersion: 0.5 }, { ...valid, sessionVersion: null }];
  for (const value of tokens) {
    tokenValue = value;
    await assertAccess(false);
    assert.equal((await post(changePassword, {})).status, 401);
  }
  tokenValue = valid;
  db.exec("DELETE FROM users");
  await assertAccess(false);
  assert.equal((await post(changePassword, {})).status, 401);
});

test("PR13: token decoding and missing database version fail closed", async () => {
  await post(signup, signupBody());
  tokenValue = await issueToken();
  tokenError = true;
  await assertAccess(false);
  assert.equal((await post(changePassword, {})).status, 401);
  tokenError = false;
  db.exec("ALTER TABLE users RENAME COLUMN session_version TO unavailable_version");
  try {
    await assertAccess(false);
    assert.equal((await post(changePassword, {})).status, 401);
  } finally {
    db.exec("ALTER TABLE users RENAME COLUMN unavailable_version TO session_version");
  }
});

test("PR13: wrong current password leaves hash and sessions unchanged", async () => {
  await post(signup, signupBody());
  tokenValue = await issueToken();
  const before = db.prepare("SELECT password_hash, session_version FROM users").get();
  assert.equal((await post(changePassword, { currentPassword: "wrong-password", newPassword: "replacement-password" })).status, 400);
  assert.deepEqual(db.prepare("SELECT password_hash, session_version FROM users").get(), before);
  await assertAccess(true);
});

test("PR13: concurrent password changes have one winner and one version increment", async () => {
  await post(signup, signupBody());
  tokenValue = await issueToken();
  hashBarrier = barrier(2);
  const passwords = ["replacement-one", "replacement-two"];
  const results = await Promise.all(passwords.map(newPassword => post(changePassword, { currentPassword: "original-password", newPassword })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
  assert.deepEqual(db.prepare("SELECT session_version FROM users").get(), { session_version: 1 });
  await assertAccess(false);
  for (let i = 0; i < results.length; i++) assert.equal(Boolean(await login(passwords[i])), results[i].status === 200);
});

for (const sameEmail of [false, true]) {
  test(`PR13: concurrent first-owner signup has one winner (same email: ${sameEmail})`, async () => {
    hashBarrier = barrier(4);
    const bodies = Array.from({ length: 4 }, (_, index) => signupBody(sameEmail ? "owner@example.invalid" : `owner-${index}@example.invalid`));
    const results = await Promise.all(bodies.map(body => post(signup, body)));
    assert.deepEqual(results.map(r => r.status).sort(), [201, 403, 403, 403]);
    assert.equal(hashCalls, 4);
    const rows = db.prepare("SELECT email, session_version FROM users").all();
    assert.deepEqual(rows, [{ email: bodies[results.findIndex(r => r.status === 201)].email, session_version: 0 }]);
    assert.ok(await login("original-password", (rows[0] as { email: string }).email));
    const before = hashCalls;
    assert.equal((await post(signup, null)).status, 403);
    assert.equal((await post(signup, { ...signupBody(), inviteCode: "wrong" })).status, 403);
    assert.equal(hashCalls, before);
  });
}

test("PR13: failed bootstrap hash leaves no owner and retry succeeds", async () => {
  hashBarrier = async () => { throw new Error("synthetic hash failure"); };
  await assert.rejects(post(signup, signupBody()), /synthetic hash failure/);
  assert.deepEqual(db.prepare("SELECT COUNT(*) c FROM users").get(), { c: 0 });
  hashBarrier = undefined;
  assert.equal((await post(signup, signupBody())).status, 201);
});

test("PR13: service-secret policy stays separate from browser sessions", async () => {
  await assertAccess(false);
  assert.equal(await api("wrong"), false);
  assert.equal(await api(overrides.INTERNAL_API_SECRET), true);
  assert.notEqual(await requirePageSession({ req: { headers: { "x-internal-secret": overrides.INTERNAL_API_SECRET } }, res: {} } as never), null);
  assert.equal((await post(changePassword, {})).status, 401);
});
