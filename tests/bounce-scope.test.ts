import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PR-14 (C3) — bounce scope.
 *
 * Acceptance: a synthetic recipient-specific delivery failure affects only the
 * correlated recipient and appropriate email work. Unrelated recipients,
 * LinkedIn tracks, company siblings and temporary failures remain unaffected.
 * Reprocessing is idempotent.
 *
 * Each test below maps to one clause. They run against a real SQLite file so
 * the SQL (track filter, note appending, company flag) is exercised, not just
 * the parser.
 */

const dbDir = mkdtempSync(join(tmpdir(), "linki-bounce-scope-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-bounce-tests";

const { getDb } = await import("@/lib/db");
const { applyBounce, parseBounce } = await import("@/lib/email/bounce");

const db = getDb();

after(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dbDir, { recursive: true, force: true });
});

let seq = 0;

interface Fixture {
  target: string;
  email: string;
  company: string | null;
  linkedinTrack: string | null;
  emailTrack: string | null;
}

/** A contact with both tracks pending, optionally in a company. */
function contact(opts: { company?: boolean; track?: boolean } = {}): Fixture {
  const n = ++seq;
  const f: Fixture = {
    target: `t-${n}`,
    email: `person${n}@example.com`,
    company: null,
    linkedinTrack: null,
    emailTrack: null,
  };
  if (opts.company !== false) {
    f.company = `co-${n}`;
    db.prepare("INSERT INTO companies (id, name) VALUES (?, ?)").run(f.company, `Co ${n}`);
  }
  db.prepare("INSERT INTO targets (id, full_name, email, company_id) VALUES (?, ?, ?, ?)")
    .run(f.target, `Person ${n}`, f.email, f.company);

  if (opts.track !== false) {
    const run = `r-${n}`;
    const profile = `p-${n}`;
    db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(`w-${n}`, `WF ${n}`);
    db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(run, `w-${n}`);
    db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(profile, run, f.target);
    f.linkedinTrack = `tr-li-${n}`;
    f.emailTrack = `tr-em-${n}`;
    db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state) VALUES (?, ?, 'linkedin', 'pending')")
      .run(f.linkedinTrack, profile);
    db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state) VALUES (?, ?, 'email', 'pending')")
      .run(f.emailTrack, profile);
  }
  return f;
}

// Our own sending address, which appears in almost every DSN body.
db.prepare(
  "INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password) VALUES ('ea-1', 'Sender', 'me@ourdomain.com', 'smtp.example.invalid', 'me', 'x')"
).run();

function dsn(opts: {
  recipient?: string;
  status?: string;
  action?: string;
  extra?: string;
}): string {
  return [
    "From: Mail Delivery System <mailer-daemon@provider.example>",
    "To: me@ourdomain.com",
    "Subject: Undelivered Mail Returned to Sender",
    "",
    "This is the mail system at host provider.example.",
    "",
    opts.recipient ? `Final-Recipient: rfc822; ${opts.recipient}` : "",
    opts.action ? `Action: ${opts.action}` : "",
    opts.status ? `Status: ${opts.status}` : "",
    "",
    "Diagnostic-Code: smtp; 550 5.1.1 User unknown",
    opts.extra ?? "",
  ].join("\n");
}

const status = (f: Fixture) =>
  (db.prepare("SELECT email_status FROM targets WHERE id = ?").get(f.target) as { email_status: string | null })
    .email_status;

const trackState = (id: string | null) =>
  id ? (db.prepare("SELECT state FROM run_profile_tracks WHERE id = ?").get(id) as { state: string } | undefined)?.state : undefined;

// ─── parsing ─────────────────────────────────────────────────────────────────

test("parseBounce: 5.1.1 is a recipient failure, 4.2.2 is temporary", () => {
  assert.equal(parseBounce(dsn({ recipient: "a@example.com", status: "5.1.1" })).kind, "recipient");
  const temp = parseBounce(dsn({ recipient: "a@example.com", status: "4.2.2" }));
  assert.equal(temp.kind, "temporary");
  assert.equal(temp.recipient, "a@example.com");
});

test("parseBounce: a domain-level status is distinguished from a mailbox failure", () => {
  assert.equal(parseBounce(dsn({ recipient: "a@example.com", status: "5.1.2" })).kind, "domain");
  assert.equal(parseBounce(dsn({ recipient: "a@example.com", status: "5.4.4" })).kind, "domain");
  assert.equal(parseBounce(dsn({ recipient: "a@example.com", status: "5.1.1" })).kind, "recipient");
});

test("parseBounce: Action: delayed is temporary even without a Status line", () => {
  assert.equal(parseBounce(dsn({ recipient: "a@example.com", action: "delayed" })).kind, "temporary");
});

// ─── the correlated recipient only ───────────────────────────────────────────

test("a permanent bounce invalidates the correlated recipient and nobody else", () => {
  const a = contact();
  const b = contact();

  const out = applyBounce(db, {
    body: dsn({
      recipient: a.email,
      status: "5.1.1",
      // A quoted original message mentions a second contact. The old code
      // invalidated whichever candidate matched first.
      extra: `--- Original message ---\nTo: ${b.email}\nFrom: me@ourdomain.com`,
    }),
  });

  assert.equal(out.applied, true);
  assert.equal(status(a), "invalid");
  assert.equal(status(b), null, "an address quoted in the body must not be invalidated");
});

test("our own from-address in the report is never treated as the recipient", () => {
  const a = contact();
  const out = applyBounce(db, {
    body: dsn({ recipient: a.email, status: "5.1.1", extra: "To: me@ourdomain.com" }),
  });
  assert.equal(out.applied, true);
  assert.equal(
    db.prepare("SELECT email_status FROM targets WHERE lower(email) = 'me@ourdomain.com'").get(),
    undefined,
    "no contact exists for our own address"
  );
});

test("no Final-Recipient and two candidate contacts: nothing is invalidated", () => {
  const a = contact();
  const b = contact();
  const out = applyBounce(db, {
    body: dsn({ status: "5.1.1", extra: `To: ${a.email}\nCc: ${b.email}` }),
  });

  assert.equal(out.applied, false);
  assert.match(out.reason, /candidate/i);
  assert.equal(status(a), null);
  assert.equal(status(b), null);
});

test("a report with no usable status is ignored rather than guessed", () => {
  const a = contact();
  const out = applyBounce(db, { body: "From: mailer-daemon@x.example\nSubject: hi\n" });
  assert.equal(out.applied, false);
  assert.equal(status(a), null);
});

// ─── track scope ─────────────────────────────────────────────────────────────

test("an email bounce skips the email track and leaves the LinkedIn track alone", () => {
  const a = contact();
  const out = applyBounce(db, { body: dsn({ recipient: a.email, status: "5.1.1" }) });

  assert.equal(out.applied, true);
  assert.equal(trackState(a.emailTrack), "skipped");
  assert.equal(trackState(a.linkedinTrack), "pending", "a dead mailbox must not stop LinkedIn outreach");
});

// ─── company siblings ────────────────────────────────────────────────────────

test("a mailbox bounce does not invalidate colleagues or flag the company", () => {
  const a = contact();
  const sibling = contact();
  db.prepare("UPDATE targets SET company_id = ? WHERE id = ?").run(a.company, sibling.target);

  const out = applyBounce(db, { body: dsn({ recipient: a.email, status: "5.1.1" }) });

  assert.equal(out.applied, true);
  assert.equal(out.companyFlagged, false);
  assert.equal(status(sibling), null, "one mailbox says nothing about a colleague's");
  assert.equal(trackState(sibling.emailTrack), "pending");
  const company = db.prepare("SELECT email_domain_invalid FROM companies WHERE id = ?").get(a.company) as
    | { email_domain_invalid: number | null }
    | undefined;
  assert.equal(company?.email_domain_invalid, 0);
});

test("a domain-level failure is the evidence that justifies flagging the company", () => {
  const a = contact();
  const sibling = contact();
  db.prepare("UPDATE targets SET company_id = ? WHERE id = ?").run(a.company, sibling.target);

  const out = applyBounce(db, { body: dsn({ recipient: a.email, status: "5.1.2" }) });

  assert.equal(out.applied, true);
  assert.equal(out.companyFlagged, true);
  const company = db.prepare("SELECT email_domain_invalid FROM companies WHERE id = ?").get(a.company) as
    | { email_domain_invalid: number | null };
  assert.equal(company.email_domain_invalid, 1);
  // The flag is evaluated at send time by the runner; siblings are not rewritten.
  assert.equal(status(sibling), null);
});

// ─── temporary failures ──────────────────────────────────────────────────────

test("a temporary failure changes nothing", () => {
  const a = contact();
  const out = applyBounce(db, { body: dsn({ recipient: a.email, status: "4.2.2" }) });

  assert.equal(out.applied, false);
  assert.match(out.reason, /temporary/i);
  assert.equal(status(a), null);
  assert.equal(trackState(a.emailTrack), "pending");
  assert.equal(trackState(a.linkedinTrack), "pending");
});

// ─── idempotency ─────────────────────────────────────────────────────────────

test("reprocessing the same report is idempotent", () => {
  const a = contact();
  const body = dsn({ recipient: a.email, status: "5.1.1" });

  assert.equal(applyBounce(db, { body }).applied, true);
  const second = applyBounce(db, { body });

  assert.equal(second.applied, false, "nothing to do the second time");
  const notes = db.prepare("SELECT notes FROM targets WHERE id = ?").get(a.target) as { notes: string };
  assert.equal(notes.notes.split("\n").length, 1, "the note must not be duplicated");
});

test("reprocessing a domain-level report does not duplicate the company note", () => {
  const a = contact();
  const b2 = contact();
  const body = dsn({ recipient: a.email, status: "5.1.2" });

  applyBounce(db, { body });
  // A second, different address at the same domain: the company is already
  // flagged, so no second note is appended.
  db.prepare("UPDATE targets SET company_id = ? WHERE id = ?").run(a.company, b2.target);
  const later = applyBounce(db, { body: dsn({ recipient: b2.email, status: "5.1.2" }) });

  assert.equal(later.applied, true, "the second address is still invalidated");
  assert.equal(later.companyFlagged, false, "the company flag was already set");
  const company = db.prepare("SELECT notes FROM companies WHERE id = ?").get(a.company) as { notes: string };
  assert.equal(company.notes.split("\n").length, 1);
});
