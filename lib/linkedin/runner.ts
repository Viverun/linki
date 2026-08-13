import { getDb } from "@/lib/db";
import { DEGRADED_AFTER_FAILURES, classifyError, UNKNOWN_ERROR_CLASS } from "@/lib/health-contract";
import { isAllowedLinkedinUrl } from "@/lib/linkedin-url";

// Re-exported so callers that already depend on the runner need not learn about
// a second module; lib/health-contract.ts remains the single definition.
export { classifyError, UNKNOWN_ERROR_CLASS };
import { randomUUID, createHash } from "crypto";
import { setInterval as nodeSetInterval } from "node:timers";
import { getSessionPage, saveSessionState, getSessionContext } from "@/lib/linkedin/session";
import { visitProfile, type VisitResult } from "@/lib/linkedin/visit";
import { sendConnectionRequest, WeeklyLimitError, AlreadyConnectedError, PendingInviteError, vanityNameOf } from "@/lib/linkedin/connect";
import { sendMessage, NotConnectedError, MessagingUrnUnresolvedError } from "@/lib/linkedin/message";
import { shouldSyncAccepted, syncAcceptedConnections } from "@/lib/linkedin/sync-accepted";
import { sendEmail } from "@/lib/email/sender";
import { shouldSyncEmailInbox, syncEmailInbox } from "@/lib/email/inbox";
import { enrichProfile } from "@/lib/linkedin/enrich";
import { matchPerson } from "@/lib/apollo";
import { premium } from "@/lib/premium";
import { decryptSecret } from "@/lib/crypto";

// Minimum gap between Sales Nav profile enrichment calls per account (ms)
const SALES_NAV_ENRICH_MIN_GAP_MS = 5 * 60 * 1000;
// Per-account timestamp of last ensureSalesNavEnriched execution
const lastSalesNavEnrichAt: Record<string, number> = {};

// Accounts that reported "No InMail credits left" today (Jul 2026 incident — LinkedIn's
// own credit balance, distinct from daily_inmail_limit; without this, a depleted account
// re-attempted InMail on every queued lead, each burning a ~30-50s Sales Nav page load for
// nothing). Keyed by accountId -> the date (YYYY-MM-DD, local) it was detected exhausted.
// In-memory only — worst case after a restart is one wasted attempt before re-detecting.
const inmailCreditsExhaustedOn: Record<string, string> = {};
function todayLocalDate(): string { return new Date().toISOString().slice(0, 10); }
function inmailCreditsExhaustedToday(accountId: string): boolean {
  return inmailCreditsExhaustedOn[accountId] === todayLocalDate();
}

// Initial wait before first acceptance check (6h)
const CONNECTION_RECHECK_HOURS = 6;
// Max days to wait for acceptance before giving up
const CONNECTION_MAX_WAIT_DAYS = 7;
// Delay between profiles (seconds)
const PROFILE_DELAY_MIN = 8;
const PROFILE_DELAY_MAX = 20;
// Poll interval (ms)
const POLL_INTERVAL_MS = 30_000;
// How far ahead a claimed track's next_step_at is pushed while it executes.
// Long enough to cover the slowest real step (Playwright invite sends have been
// observed around 45s), short enough that a track orphaned by a crashed process
// comes back on its own without manual intervention.
const CLAIM_LEASE_MINUTES = 15;

interface ScheduleConfig {
  active_hours_start: number;
  active_hours_end: number;
  timezone: string;
  working_days: string;
}

interface AccountLimits extends ScheduleConfig {
  daily_connection_limit: number;
  daily_message_limit: number;
  daily_inmail_limit: number;
}

interface EmailAccountLimits extends ScheduleConfig {
  daily_email_limit: number;
  ramp_up_enabled: number | null;
  ramp_start_date: string | null;
}

function effectiveEmailLimit(account: EmailAccountLimits): number {
  if (!account.ramp_up_enabled || !account.ramp_start_date) return account.daily_email_limit;
  const daysActive = Math.max(1, Math.floor((Date.now() - new Date(account.ramp_start_date).getTime()) / 86_400_000) + 1);
  const ramped = daysActive * 2;
  return Math.min(account.daily_email_limit, ramped);
}

function getLocalParts(tz: string, date = new Date()): { hour: number; minute: number; isoWeekday: number } {
  const safeZone = (() => { try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return tz; } catch { return "UTC"; } })();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone,
    hour: "numeric", minute: "numeric", weekday: "short", hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  const hour = parseInt(get("hour"), 10) % 24;
  const minute = parseInt(get("minute"), 10);
  const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { hour, minute, isoWeekday: weekdayMap[get("weekday")] ?? 1 };
}

function isWithinSchedule(account: ScheduleConfig): boolean {
  const { hour, minute, isoWeekday } = getLocalParts(account.timezone || "UTC");
  const allowedDays = (account.working_days || "1,2,3,4,5").split(",").map(Number);
  if (!allowedDays.includes(isoWeekday)) return false;
  const frac = hour + minute / 60;
  return frac >= (account.active_hours_start ?? 9) && frac < (account.active_hours_end ?? 18);
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(guess);

    const get = (type: string) =>
      parts.find(p => p.type === type)?.value ?? "0";

    const localAsUtc = Date.UTC(
      parseInt(get("year"), 10),
      parseInt(get("month"), 10) - 1,
      parseInt(get("day"), 10),
      parseInt(get("hour"), 10) % 24,
      parseInt(get("minute"), 10),
      parseInt(get("second"), 10),
    );

    const offset = localAsUtc - guess.getTime();
    guess = new Date(
      Date.UTC(year, month - 1, day, hour, minute, 0) - offset
    );
  }

  return guess;
}

function randomSlotInActiveWindow(account: ScheduleConfig, targetDate?: Date): string {
  const start = account.active_hours_start ?? 9;
  const end = account.active_hours_end ?? 18;
  const timezone = account.timezone || "UTC";
  const base = targetDate ? new Date(targetDate) : new Date();

  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(base);

  const get = (type: string) =>
    dateParts.find(p => p.type === type)?.value ?? "0";

  const year = parseInt(get("year"), 10);
  const month = parseInt(get("month"), 10);
  const day = parseInt(get("day"), 10);

  const startUtc = zonedDateTimeToUtc(year, month, day, start, 0, timezone);
  const endUtc = zonedDateTimeToUtc(year, month, day, end, 0, timezone);

  const slot =
    startUtc.getTime() +
    Math.random() * (endUtc.getTime() - startUtc.getTime());

  return new Date(slot).toISOString();
}

function rescheduleToTomorrow(account: ScheduleConfig): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return randomSlotInActiveWindow(account, tomorrow);
}

function nextScheduledSlot(account: ScheduleConfig): string {
  const tz = account.timezone || "UTC";
  const allowedDays = (account.working_days || "1,2,3,4,5").split(",").map(Number);
  const end = account.active_hours_end ?? 18;
  const { hour: nowHour, minute: nowMin, isoWeekday: nowDay } = getLocalParts(tz);
  const nowFrac = nowHour + nowMin / 60;
  if (allowedDays.includes(nowDay) && nowFrac < end - 0.25) {
    const remaining = (end - nowFrac) * 3600_000;
    return new Date(Date.now() + Math.random() * remaining).toISOString();
  }
  const candidate = new Date();
  for (let i = 1; i <= 14; i++) {
    candidate.setDate(candidate.getDate() + 1);
    const { isoWeekday } = getLocalParts(tz, candidate);
    if (allowedDays.includes(isoWeekday)) return randomSlotInActiveWindow(account, candidate);
  }
  return new Date(Date.now() + 86_400_000).toISOString();
}

interface WorkflowStep {
  id: string;
  step_order: number;
  track: "linkedin" | "email";
  step_type: "visit" | "connect" | "message" | "sales_inmail" | "delay" | "email";
  template_id: string | null;
  delay_seconds: number;
  connect_note: string | null;
  message_body: string | null;
  email_subject: string | null;
  email_body: string | null;
  ai_enabled: number | null;
  ai_model: string | null;
  ai_prompt: string | null;
  ai_max_words: number | null;
  ai_language: string | null;
  email_position: number | null;
  message_position: number | null;
  email_signature: string | null;
}

// A track-run row joined with its parent run_profile and run context
interface TrackRun {
  // run_profile_tracks columns
  id: string;
  run_profile_id: string;
  track: "linkedin" | "email";
  state: string;
  current_step: number;
  next_step_at: string | null;
  error_message: string | null;
  last_email_subject: string | null;
  last_email_body: string | null;
  last_linkedin_message: string | null;
  pending_reply_context: string | null;
  // joined from run_profiles / runs
  run_id: string;
  target_id: string;
  email_account_id: string | null;
  account_id: string;
  workflow_id: string;
  // joined from targets — lets the daily-limit gate tell a NEW connect send apart
  // from a free acceptance recheck on an already-sent request
  connection_requested_at: string | null;
}

interface Target {
  id: string;
  linkedin_url: string;
  sales_nav_url: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  degree: number | null;
  connection_requested_at: string | null;
  connected_at: string | null;
  email: string | null;
  email_status: string | null;
  email_replied_at: string | null;
  company_id: string | null;
  messaging_urn: string | null;
}

interface Template { id: string; body: string; }

// ─── helpers ────────────────────────────────────────────────────────────────

function log(db: ReturnType<typeof getDb>, runId: string, targetId: string | null, level: "info" | "warn" | "error", message: string) {
  db.prepare("INSERT INTO logs (id, run_id, target_id, level, message) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), runId, targetId, level, message);
  console.log(`[runner] [${level}] run=${runId} target=${targetId ?? "-"} ${message}`);
}

function renderTemplate(body: string, target: Target): string {
  return body
    .replace(/\{\{first_name\}\}/gi, target.first_name ?? target.full_name?.split(" ")[0] ?? "")
    .replace(/\{\{last_name\}\}/gi,  target.last_name ?? target.full_name?.split(" ").slice(1).join(" ") ?? "")
    .replace(/\{\{full_name\}\}/gi,  target.full_name ?? "")
    .replace(/\{\{company\}\}/gi,    target.company ?? "")
    .replace(/\{\{title\}\}/gi,      target.title ?? "")
    .replace(/\{\{location\}\}/gi,   target.location ?? "")
    .trim();
}

// ─── runner liveness ─────────────────────────────────────────────────────────
// Two independent signals, because one cannot express both failure modes.
//
//  * PROGRESS marker — written at every executeStep boundary, after the accepted-
//    connections sync, and at loop-iteration start. Staleness here means the
//    runner is DEAD. Per-STEP rather than per-tick on purpose: tick() executes
//    every due track sequentially with no cap (NF-5), so tick duration scales
//    with workload and a tick-completion timestamp can be legitimately stale for
//    an hour. A threshold above an unbounded quantity is not slow detection, it
//    is no detection.
//
//  * consecutive_tick_failures — a COUNTER, not a timestamp, because a tick that
//    throws every iteration keeps the progress marker fresh (the loop is alive)
//    while accomplishing nothing. That is NF-4, and no timestamp separates it
//    from a large healthy tick.
//
// The liveness threshold lives in the health route and is derived from the
// timeout budget in docs/phase1-baseline.md. Changing any Playwright timeout
// invalidates it; that table cross-references both ways.
const HEARTBEAT_KEYS = {
  progressAt: "runner_progress_at",
  progressPhase: "runner_progress_phase",
  tickFailures: "runner_tick_failures",
  lastErrorClass: "runner_last_error_class",
} as const;

function putSetting(db: ReturnType<typeof getDb>, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value);
}

export type RunnerAlertState = "healthy" | "degraded" | "dead";

const ALERT_KEYS = { lastState: "alert_last_state" } as const;



/**
 * Announces a runner state change to an operator.
 *
 * Fires on TRANSITION, never per tick: a tick failing every 30s would otherwise
 * produce 2,880 notifications a day, which is indistinguishable from no
 * notification. The last announced state is persisted, because "transition" is
 * unknowable across a restart otherwise.
 *
 * Wrapped end to end. A webhook is the least reliable thing the runner touches,
 * and it runs immediately after work that may have already changed LinkedIn — it
 * must never be able to fail a tick, exactly like the heartbeat.
 */
export async function notifyRunnerState(
  db: ReturnType<typeof getDb>,
  detail: { state: RunnerAlertState; failures: number; errorClass?: string }
): Promise<void> {
  try {
    const previous = (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(ALERT_KEYS.lastState) as { value: string } | undefined)?.value;

    // Always record the state — this is what makes "transition" meaningful across
    // a restart, and it is written even when no webhook is configured so that
    // turning one on later does not immediately re-announce a stale state.
    putSetting(db, ALERT_KEYS.lastState, detail.state);

    if (previous === detail.state) return;                   // not a transition
    // First observation of a healthy runner is a boot, not a recovery. Without
    // this every process start announces itself.
    if (previous === undefined && detail.state === "healthy") return;

    const url = process.env.ALERT_WEBHOOK_URL;
    if (!url) return;

    // Recovery IS announced. An operator woken at 3am by a degraded alert needs
    // to know it cleared without logging in to check; an alerter that only ever
    // reports bad news trains people to ignore it.
    // EXACT payload. Never a message body, target name, vanity, workflow name, or
    // anything from `accounts`. New fields are how those eventually leak.
    const body = {
      service: "linki",
      state: detail.state,
      consecutive_tick_failures: detail.failures,
      error_class: detail.errorClass ?? UNKNOWN_ERROR_CLASS,
      timestamp: nowIso(),
    };
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (err) {
    console.warn("[runner] alert notification failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Marks that the runner is still making progress. Never allowed to fail a tick:
 * a bookkeeping write must not be able to stop the work it observes.
 */
export function recordProgress(db: ReturnType<typeof getDb>, phase: string): void {
  try {
    putSetting(db, HEARTBEAT_KEYS.progressAt, nowIso());
    putSetting(db, HEARTBEAT_KEYS.progressPhase, phase);
  } catch (err) {
    console.warn("[runner] heartbeat write failed:", err instanceof Error ? err.message : err);
  }
}

/** Error CLASS only — never the message, which can carry profile URLs (I9). */
/**
 * Fires a notification without making a synchronous bookkeeping function async.
 *
 * `notifyRunnerState` persists the state before its first `await`, so the
 * transition record is written synchronously here; only the HTTP POST is
 * deferred. It cannot reject — it is wrapped end to end — but `.catch` is kept
 * so a future edit that removes that wrapper cannot produce an unhandled
 * rejection that takes the process down.
 */
function announce(db: ReturnType<typeof getDb>, detail: { state: RunnerAlertState; failures: number; errorClass?: string }): void {
  void notifyRunnerState(db, detail).catch(() => { /* never surfaces */ });
}

export function recordTickOutcome(db: ReturnType<typeof getDb>, err: unknown): void {
  try {
    if (!err) {
      putSetting(db, HEARTBEAT_KEYS.tickFailures, "0");
      putSetting(db, HEARTBEAT_KEYS.lastErrorClass, "");
      announce(db, { state: "healthy", failures: 0 });
      return;
    }
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(HEARTBEAT_KEYS.tickFailures) as { value: string } | undefined;
    const next = (parseInt(row?.value ?? "0", 10) || 0) + 1;
    const errorClass = classifyError(err);
    putSetting(db, HEARTBEAT_KEYS.tickFailures, String(next));
    putSetting(db, HEARTBEAT_KEYS.lastErrorClass, errorClass);
    // Announced HERE rather than at the loop's call site: the counter and the
    // announcement are one fact, and a second caller of recordTickOutcome would
    // otherwise increment silently. Same multi-site lesson as M8/M16.
    if (next >= DEGRADED_AFTER_FAILURES) announce(db, { state: "degraded", failures: next, errorClass });
  } catch (e) {
    console.warn("[runner] tick-outcome write failed:", e instanceof Error ? e.message : e);
  }
}

// ─── side-effect ledger ──────────────────────────────────────────────────────
// Irreversible LinkedIn actions (message, InMail) happen outside the database,
// so the writes that follow one can never be atomic with it. Record the INTENT
// first, confirm after: "did we already send this?" then survives a crash, a
// SQLITE_BUSY, or a browser teardown failure between the Send click and
// targets.message_sent_at. Without this a post-send throw fails the track with
// no record of delivery, and Retry sends the same message to the same human
// again — the exact harm this whole branch exists to prevent.

/**
 * Raised when a previous attempt may already have delivered this message, so
 * sending again would risk a duplicate. Deliberately NOT auto-recoverable:
 * LinkedIn gives messaging no equivalent of verifyInvitationSent(), so silence
 * has to mean "possibly delivered" and a human has to resolve it.
 */
export class UnresolvedSideEffectError extends Error {}

export type SideEffectAction = "message" | "inmail";

export interface SideEffectRow {
  id: string;
  status: "in_flight" | "confirmed" | "abandoned";
  step_ref: string;
  body_fingerprint: string | null;
  attempt_count: number;
}

/** Scheme-prefixed step identity. See the migration comment in lib/db.ts. */
export function stepRefOf(step: { message_position: number | null }): string {
  return `pos:${step.message_position ?? 1}`;
}

/**
 * sha256 of the rendered body, whitespace-normalised. Case and punctuation are
 * preserved — two messages differing only in case are different messages.
 * The hash is stored; the plaintext is never logged anywhere new.
 */
export function bodyFingerprint(text: string): string {
  return createHash("sha256").update(text.trim().replace(/\s+/g, " ")).digest("hex");
}

function sideEffectFor(
  db: ReturnType<typeof getDb>,
  runProfileId: string, track: string, stepRef: string, action: SideEffectAction
): SideEffectRow | undefined {
  return db.prepare(
    `SELECT id, status, step_ref, body_fingerprint, attempt_count FROM step_side_effects
     WHERE run_profile_id = ? AND track = ? AND step_ref = ? AND action = ?`
  ).get(runProfileId, track, stepRef, action) as SideEffectRow | undefined;
}

/**
 * Layer 2. Has this exact body already gone to this person in this enrolment
 * under a DIFFERENT step_ref? That is the position-shift case: re-saving a
 * campaign with a new message inserted earlier renumbers an already-delivered
 * message, so Layer 1's position key no longer matches and would re-send.
 * Scoped to (run_profile_id, target_id) on purpose — blocking identical text
 * across unrelated campaigns is a product decision, not this guard's business.
 */
function conflictingFingerprint(
  db: ReturnType<typeof getDb>,
  runProfileId: string, targetId: string, stepRef: string, fingerprint: string | null
): SideEffectRow | undefined {
  if (!fingerprint) return undefined;
  return db.prepare(
    `SELECT id, status, step_ref, body_fingerprint, attempt_count FROM step_side_effects
     WHERE run_profile_id = ? AND target_id = ? AND body_fingerprint = ?
       AND step_ref != ? AND status IN ('in_flight', 'confirmed') LIMIT 1`
  ).get(runProfileId, targetId, fingerprint, stepRef) as SideEffectRow | undefined;
}

/**
 * True only for failures that PROVABLY happen before the Send click, so the
 * recorded intent can safely be retracted and the step retried.
 *
 * Traced against lib/linkedin/message.ts, where the click is `sendBtn.click()`
 * at :108:
 *   - NotConnectedError          thrown at :49, before compose is even opened
 *   - MessagingUrnUnresolvedError thrown at :65, reached only when
 *                                openComposeByUrn() returned false, i.e. the
 *                                compose box never rendered and nothing was typed
 *   - the runner's own no-full_name guard, thrown before sendMessage is called
 *
 * Everything else — a locator timeout inside sendFromComposeBox, a teardown
 * race, and above all `page.waitForTimeout(2000)` at message.ts:109 which runs
 * AFTER the click — may coexist with a delivered message, so it must not
 * retract the intent. Default is false: unknown means possibly-delivered.
 */
function isPreSendFailure(err: unknown): boolean {
  if (err instanceof NotConnectedError) return true;
  if (err instanceof MessagingUrnUnresolvedError) return true;
  return err instanceof Error && /has no full_name/.test(err.message);
}

/**
 * Records intent. Must be committed BEFORE the irreversible action.
 *
 * Upsert, not insert: a previous attempt that failed BEFORE the send leaves an
 * `abandoned` row under the same unique key, and a plain INSERT would then throw
 * a constraint error on every subsequent attempt — permanently wedging a step
 * that never actually sent anything. Re-arming that row back to `in_flight` and
 * counting the attempt is the whole point of `attempt_count`.
 *
 * Only `abandoned` rows are re-armed. `in_flight` and `confirmed` are filtered
 * out by the pre-send gate before this is ever called, so a delivered message
 * can never be reset to `in_flight` here.
 */
function sideEffectBegin(
  db: ReturnType<typeof getDb>,
  tr: TrackRun, stepRef: string, action: SideEffectAction, fingerprint: string | null
): void {
  db.prepare(
    `INSERT INTO step_side_effects
       (id, run_profile_id, track, step_ref, target_id, action, status, body_fingerprint, started_at)
     VALUES (?, ?, ?, ?, ?, ?, 'in_flight', ?, ?)
     ON CONFLICT(run_profile_id, track, step_ref, action) DO UPDATE SET
       status           = 'in_flight',
       body_fingerprint = excluded.body_fingerprint,
       started_at       = excluded.started_at,
       confirmed_at     = NULL,
       error_message    = NULL,
       attempt_count    = step_side_effects.attempt_count + 1
     WHERE step_side_effects.status = 'abandoned'`
  ).run(randomUUID(), tr.run_profile_id, tr.track, stepRef, tr.target_id, action, fingerprint, nowIso());
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
/**
 * Backoff sleep that does NOT hold the event loop open. The HTTP server keeps
 * the process alive in production, so unref costs nothing there — but a runner
 * stuck in recovery must never be the reason a process (or a test run) cannot
 * exit. Same precedent as the unref'd interval in lib/update-check.ts.
 */
function sleepUnref(ms: number) {
  return new Promise<void>(r => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); });
}
function randomDelay(minSec: number, maxSec: number) { return sleep((minSec + Math.random() * (maxSec - minSec)) * 1000); }
function nowIso() { return new Date().toISOString(); }
function addHours(h: number) { return new Date(Date.now() + h * 3600_000).toISOString(); }
function hoursSince(isoStr: string) { return (Date.now() - new Date(isoStr).getTime()) / 3600_000; }

// ─── TrackRun verb layer ─────────────────────────────────────────────────────
// These are the only functions that write to run_profile_tracks rows.

function trAdvance(db: ReturnType<typeof getDb>, tr: TrackRun, steps: WorkflowStep[]) {
  const nextIndex = tr.current_step + 1;
  if (nextIndex >= steps.length) {
    db.prepare(
      "UPDATE run_profile_tracks SET state = 'completed', current_step = ?, last_step_at = datetime('now'), next_step_at = NULL WHERE id = ?"
    ).run(nextIndex, tr.id);
  } else {
    const nextStep = steps[nextIndex];
    const nextAt = nextStep.delay_seconds > 0 ? new Date(Date.now() + nextStep.delay_seconds * 1000).toISOString() : null;
    db.prepare(
      "UPDATE run_profile_tracks SET current_step = ?, last_step_at = datetime('now'), next_step_at = ? WHERE id = ?"
    ).run(nextIndex, nextAt, tr.id);
  }
}

function trWait(db: ReturnType<typeof getDb>, tr: TrackRun, hours: number) {
  db.prepare("UPDATE run_profile_tracks SET next_step_at = ? WHERE id = ?").run(addHours(hours), tr.id);
}

/**
 * Atomically claim a due track before executing it. Returns false if the claim
 * was lost, in which case the caller must skip the track entirely.
 *
 * The due-query and the execution used to be separate statements, so a track
 * stayed `in_progress` with `next_step_at` in the past for the whole step —
 * ~45s for a Playwright invite. Anything else reading the DB in that window
 * (a second runner process or container, or this process restarting mid-step)
 * saw the same row as due and ran it again, sending a duplicate invite.
 *
 * The WHERE clause re-asserts the exact predicate the due-query used, so the
 * check and the claim are one statement and SQLite settles the race: exactly
 * one caller sees changes === 1. The new next_step_at is only a lease — every
 * terminal path in executeStep (trAdvance/trWait/trReschedule/trSkip/trFail)
 * overwrites it, so normal scheduling is unaffected. If the process dies first,
 * the lease expires and the track becomes due again on its own.
 */
export function trClaim(db: ReturnType<typeof getDb>, trackId: string): boolean {
  // ISO-UTC via toISOString(), matching every other next_step_at write here.
  const leaseUntil = new Date(Date.now() + CLAIM_LEASE_MINUTES * 60_000).toISOString();
  const claimed = db.prepare(
    `UPDATE run_profile_tracks SET next_step_at = ?
     WHERE id = ? AND state = 'in_progress'
       AND (next_step_at IS NULL OR datetime(next_step_at) <= datetime('now'))`
  ).run(leaseUntil, trackId);
  return claimed.changes === 1;
}

function trReschedule(db: ReturnType<typeof getDb>, tr: TrackRun, isoTimestamp: string) {
  db.prepare("UPDATE run_profile_tracks SET next_step_at = ? WHERE id = ?").run(isoTimestamp, tr.id);
}

function trSkip(db: ReturnType<typeof getDb>, tr: TrackRun, reason: string) {
  db.prepare("UPDATE run_profile_tracks SET state = 'skipped', error_message = ? WHERE id = ?").run(reason, tr.id);
}

function trFail(db: ReturnType<typeof getDb>, tr: TrackRun, reason: string) {
  db.prepare("UPDATE run_profile_tracks SET state = 'failed', error_message = ? WHERE id = ?").run(reason, tr.id);
}

function trRecordContext(db: ReturnType<typeof getDb>, tr: TrackRun, ctx: { linkedinMessage?: string; emailSubject?: string; emailBody?: string }) {
  if (ctx.linkedinMessage !== undefined) {
    db.prepare("UPDATE run_profile_tracks SET last_linkedin_message = ? WHERE id = ?").run(ctx.linkedinMessage, tr.id);
  }
  if (ctx.emailSubject !== undefined || ctx.emailBody !== undefined) {
    db.prepare("UPDATE run_profile_tracks SET last_email_subject = ?, last_email_body = ? WHERE id = ?")
      .run(ctx.emailSubject ?? null, ctx.emailBody ?? null, tr.id);
  }
}

// ─── enforceSchedule helper ──────────────────────────────────────────────────
// Returns true if the step may proceed. Returns false and reschedules if outside the window.

function enforceSchedule(
  db: ReturnType<typeof getDb>,
  tr: TrackRun,
  runId: string,
  targetId: string,
  name: string,
  schedule: ScheduleConfig
): boolean {
  if (isWithinSchedule(schedule)) return true;
  const nextSlot = nextScheduledSlot(schedule);
  log(db, runId, targetId, "info", `Outside working schedule — rescheduling ${name} to ${nextSlot}`);
  trReschedule(db, tr, nextSlot);
  return false;
}

// ─── URL resolution ──────────────────────────────────────────────────────────

/**
 * N7b: a profile URL that yields no vanity must never enter the system.
 *
 * Every downstream consumer treats the vanity as the thing that identifies WHO
 * this is: the invitation CTA is bound by `vanityName`, the sent-invitations
 * scrape is keyed by it, and the accepted-connections reconciliation matches on
 * it. When it is null each of those has to decide what absence means, and the
 * wrong answer ranges from doing nothing, to inviting a stranger (N7), to wiping
 * a real connection (the unmark pass in sync-accepted.ts).
 *
 * Rejecting once, here, means no downstream consumer has to be individually
 * correct. N7's symmetric refusal in connect.ts stays as defence in depth: two
 * independent guards, the same pattern as the side-effect ledger's two layers.
 */
/**
 * NF-9: the URL is well-formed and yields a vanity, but is not on LinkedIn.
 *
 * Separate from UnresolvableProfileUrlError on purpose. "I cannot tell who this
 * is" and "this is not LinkedIn" call for different operator responses — fix the
 * profile link, versus work out how a foreign URL got into the contact list —
 * and collapsing them into one error would hide the second, which is the more
 * alarming of the two.
 */
export class UntrustedProfileHostError extends Error {
  constructor(targetLabel: string, host: string) {
    // The HOST is included: it is the one piece an operator needs to act, it is
    // not a secret, and it is bounded (a hostname, not a full URL with query
    // parameters that may carry tokens).
    super(`${targetLabel} has a LinkedIn URL pointing at "${host}", which is not linkedin.com — refusing to navigate`);
    this.name = "UntrustedProfileHostError";
  }
}

function hostOf(raw: string): string {
  try { return new URL(raw).hostname || "(unparseable)"; } catch { return "(unparseable)"; }
}

export class UnresolvableProfileUrlError extends Error {
  constructor(targetLabel: string) {
    // A label the operator can act on. Never the URL itself — it is user-supplied
    // and this message reaches logs.
    super(`${targetLabel} has a LinkedIn URL with no resolvable profile name — refusing to act on it`);
    this.name = "UnresolvableProfileUrlError";
  }
}

export async function resolveLinkedinUrl(db: ReturnType<typeof getDb>, target: Target, accountId: string): Promise<string> {
  // `includes("/in/")` was a SUBSTRING test, not a shape test. Verified by
  // execution: "https://www.linkedin.com/in/", "https://example.com/in/",
  // "linkedin.com/in/?trk=x" and ".../in//" all satisfy it and all yield a null
  // vanity. POST /api/targets validates only that the field is truthy, so an
  // operator pasting a truncated URL reaches this.
  if (target.linkedin_url?.includes("/in/")) {
    // HOST FIRST. A foreign host with a parseable vanity — example.com/in/bob —
    // cleared both the substring gate and the null check, and the consequence is
    // worse than either: it points the authenticated browser at attacker-chosen
    // content. Checked before the vanity so the more serious refusal is the one
    // reported.
    if (!isAllowedLinkedinUrl(target.linkedin_url)) {
      throw new UntrustedProfileHostError(target.full_name ?? target.id, hostOf(target.linkedin_url));
    }
    if (vanityNameOf(target.linkedin_url) === null) {
      throw new UnresolvableProfileUrlError(target.full_name ?? target.id);
    }
    return target.linkedin_url;
  }
  const salesNavUrl = target.sales_nav_url ?? target.linkedin_url;
  if (!salesNavUrl) throw new Error(`${target.full_name ?? target.id} has no Sales Nav URL to resolve from`);
  const leadMatch = salesNavUrl.match(/\/sales\/lead\/(.+)/);
  if (!leadMatch) throw new Error(`${target.full_name ?? target.id} has no Sales Nav lead URL — cannot resolve LinkedIn URL`);

  const page = await getSessionPage(accountId);
  let profileJson: Record<string, unknown> | null = null;
  try {
    page.on("response", async (response) => {
      if (response.url().includes("salesApiProfiles/") && response.status() === 200 && !profileJson) {
        try { profileJson = await response.json() as Record<string, unknown>; } catch { /* ignore */ }
      }
    });
    await page.goto(`https://www.linkedin.com/sales/lead/${leadMatch[1]}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(10000);
  } finally {
    await page.close();
  }

  const p = profileJson as Record<string, unknown> | null;
  const flagshipUrl = typeof p?.flagshipProfileUrl === "string" ? p.flagshipProfileUrl : null;
  if (!flagshipUrl) throw new Error(`Could not resolve LinkedIn URL for ${target.full_name ?? target.id}`);
  const linkedinUrl = flagshipUrl.endsWith("/") ? flagshipUrl : flagshipUrl + "/";
  // The SECOND exit, and the one audit Unknown #1 is about: this URL comes from
  // LinkedIn's own payload, and whether it can lack a vanity is unresolved.
  // Checking it here makes the answer not matter — the guard holds either way.
  if (!isAllowedLinkedinUrl(linkedinUrl)) {
    throw new UntrustedProfileHostError(target.full_name ?? target.id, hostOf(linkedinUrl));
  }
  if (vanityNameOf(linkedinUrl) === null) {
    throw new UnresolvableProfileUrlError(target.full_name ?? target.id);
  }

  type RawPosition = { title?: unknown; companyName?: unknown; current?: unknown; startedOn?: unknown; endedOn?: unknown; description?: unknown };
  const rawPositions = Array.isArray(p?.positions) ? (p.positions as RawPosition[]) : [];
  const positions = rawPositions.map((pos) => ({
    title: typeof pos.title === "string" ? pos.title : "",
    companyName: typeof pos.companyName === "string" ? pos.companyName : "",
    current: pos.current === true,
    startedOn: pos.startedOn as { year?: number; month?: number } | undefined,
    endedOn: pos.endedOn as { year?: number; month?: number } | undefined,
    description: typeof pos.description === "string" ? pos.description : undefined,
  }));
  type RawSkill = { name?: unknown };
  const rawSkills = Array.isArray(p?.skills) ? (p.skills as RawSkill[]) : [];
  const skills = rawSkills.map((s) => (typeof s.name === "string" ? s.name : "")).filter(Boolean);

  db.prepare(`
    UPDATE targets SET
      linkedin_url         = ?,
      linkedin_member_urn  = COALESCE(linkedin_member_urn, ?),
      headline             = COALESCE(headline, ?),
      summary              = COALESCE(summary, ?),
      positions_json       = COALESCE(positions_json, ?),
      skills_json          = CASE WHEN skills_json IS NULL AND ? IS NOT NULL THEN ? ELSE skills_json END,
      enriched_profile_at  = COALESCE(enriched_profile_at, datetime('now'))
    WHERE id = ?
  `).run(
    linkedinUrl,
    typeof p?.objectUrn === "string" ? p.objectUrn : null,
    typeof p?.headline === "string" ? p.headline : null,
    typeof p?.summary === "string" ? p.summary : null,
    positions.length > 0 ? JSON.stringify(positions) : null,
    skills.length > 0 ? "1" : null,
    skills.length > 0 ? JSON.stringify(skills) : null,
    target.id
  );
  return linkedinUrl;
}

async function getLinkedinUrl(db: ReturnType<typeof getDb>, target: Target, accountId: string): Promise<string> {
  if (target.linkedin_url?.includes("/in/")) return target.linkedin_url;
  return resolveLinkedinUrl(db, target, accountId);
}

// ─── pre-action enrichment ───────────────────────────────────────────────────

async function ensureSalesNavEnriched(db: ReturnType<typeof getDb>, target: Target, accountId: string): Promise<void> {
  const fresh = db.prepare("SELECT enriched_profile_at, apollo_enriched_at, sales_nav_url, full_name FROM targets WHERE id = ?").get(target.id) as { enriched_profile_at: string | null; apollo_enriched_at: string | null; sales_nav_url: string | null; full_name: string | null } | undefined;
  if (!fresh || fresh.enriched_profile_at || fresh.apollo_enriched_at || !fresh.sales_nav_url) return;
  const last = lastSalesNavEnrichAt[accountId] ?? 0;
  if (Date.now() - last < SALES_NAV_ENRICH_MIN_GAP_MS) return;
  try {
    lastSalesNavEnrichAt[accountId] = Date.now();
    const ctx = await getSessionContext(accountId);
    await enrichProfile(ctx, { id: target.id, sales_nav_url: fresh.sales_nav_url, full_name: fresh.full_name ?? target.full_name ?? target.id });
  } catch (e) {
    console.warn(`[runner] Sales Nav enrichment failed for ${target.full_name ?? target.id}:`, e instanceof Error ? e.message : e);
  }
}

async function ensureApolloEnriched(db: ReturnType<typeof getDb>, target: Target, runId: string): Promise<void> {
  const fresh = db.prepare("SELECT apollo_enriched_at, email, linkedin_url, sales_nav_url FROM targets WHERE id = ?").get(target.id) as { apollo_enriched_at: string | null; email: string | null; linkedin_url: string | null; sales_nav_url: string | null } | undefined;
  if (!fresh || fresh.apollo_enriched_at || fresh.email) return;
  const apolloUrl = fresh.linkedin_url?.includes("/in/") ? fresh.linkedin_url : fresh.sales_nav_url;
  if (!apolloUrl) return;

  const integration = db.prepare("SELECT api_key FROM integrations WHERE key = 'apollo'").get() as { api_key: string } | undefined;
  if (!integration?.api_key) return;

  try {
    const result = await matchPerson(apolloUrl, decryptSecret(integration.api_key)!);
    if (!result) {
      db.prepare("UPDATE targets SET apollo_enriched_at = datetime('now') WHERE id = ?").run(target.id);
      return;
    }

    let companyId: string | null = null;
    if (result.organization?.domain) {
      const domain = result.organization.domain.replace(/^www\./, "").toLowerCase();
      const existing = db.prepare("SELECT id FROM companies WHERE domain = ?").get(domain) as { id: string } | undefined;
      const org = result.organization;
      if (existing) {
        companyId = existing.id;
        db.prepare(`
          UPDATE companies SET
            industry = COALESCE(industry, ?), location = COALESCE(location, ?),
            linkedin_url = COALESCE(linkedin_url, ?), website = COALESCE(website, ?),
            founded_year = COALESCE(founded_year, ?), logo_url = COALESCE(logo_url, ?),
            phone = COALESCE(phone, ?), annual_revenue = COALESCE(annual_revenue, ?),
            technology_names = COALESCE(technology_names, ?), keywords = COALESCE(keywords, ?),
            city = COALESCE(city, ?), country = COALESCE(country, ?),
            description = COALESCE(description, ?), employee_count = COALESCE(employee_count, ?)
          WHERE id = ?
        `).run(
          org.industry ?? null, org.location ?? null, org.linkedin_url ?? null,
          org.website_url ?? null, org.founded_year ?? null, org.logo_url ?? null,
          org.phone ?? null, org.annual_revenue_printed ?? null,
          org.technology_names ? JSON.stringify(org.technology_names) : null,
          org.keywords ? JSON.stringify(org.keywords) : null,
          org.city ?? null, org.country ?? null,
          org.short_description ?? null, org.estimated_num_employees ?? null,
          existing.id
        );
      } else {
        companyId = randomUUID();
        db.prepare(`
          INSERT INTO companies (id, name, domain, industry, location, linkedin_url, website, founded_year, logo_url, phone, annual_revenue, technology_names, keywords, city, country, description, employee_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          companyId, org.name ?? "", domain,
          org.industry ?? null, org.location ?? null, org.linkedin_url ?? null,
          org.website_url ?? null, org.founded_year ?? null, org.logo_url ?? null,
          org.phone ?? null, org.annual_revenue_printed ?? null,
          org.technology_names ? JSON.stringify(org.technology_names) : null,
          org.keywords ? JSON.stringify(org.keywords) : null,
          org.city ?? null, org.country ?? null,
          org.short_description ?? null, org.estimated_num_employees ?? null
        );
      }
    }

    db.prepare(`
      UPDATE targets SET
        apollo_id = ?, seniority = ?, apollo_functions = ?, apollo_departments = ?,
        email = COALESCE(email, ?), email_status = COALESCE(email_status, ?),
        email_domain_catchall = ?,
        city = COALESCE(city, ?), country = COALESCE(country, ?),
        time_zone = COALESCE(time_zone, ?),
        headline = COALESCE(headline, ?),
        positions_json = COALESCE(positions_json, ?),
        company_id = COALESCE(company_id, ?),
        linkedin_url = COALESCE(linkedin_url, ?),
        apollo_enriched_at = datetime('now')
      WHERE id = ?
    `).run(
      result.apollo_id,
      result.seniority ?? null,
      result.functions ? JSON.stringify(result.functions) : null,
      result.departments ? JSON.stringify(result.departments) : null,
      result.email ?? null,
      result.email_status ?? null,
      result.email_domain_catchall ? 1 : 0,
      result.city ?? null,
      result.country ?? null,
      result.time_zone ?? null,
      result.headline ?? null,
      result.positions_json ?? null,
      companyId,
      result.linkedin_url ?? null,
      target.id
    );
    console.log(`[runner] Apollo enriched ${target.full_name ?? target.id} — email: ${result.email ?? "not found"}`);
  } catch (e) {
    console.warn(`[runner] Apollo enrichment failed for ${target.full_name ?? target.id}:`, e instanceof Error ? e.message : e);
  }
}

// ─── step execution ──────────────────────────────────────────────────────────

// Exported for tests: lets the connect step's error handling be driven with
// the LinkedIn modules mocked out, without standing up a whole tick.
export async function executeStep(
  db: ReturnType<typeof getDb>,
  runId: string,
  tr: TrackRun,
  target: Target,
  steps: WorkflowStep[],
  accountId: string,
  accountLimits: AccountLimits,
  emailAccountId?: string | null,
  emailAccountLimits?: EmailAccountLimits | null,
  campaignPrompt?: string | null
): Promise<void> {
  const stepIndex = tr.current_step;
  if (stepIndex >= steps.length) {
    db.prepare("UPDATE run_profile_tracks SET state = 'completed', last_step_at = datetime('now') WHERE id = ?").run(tr.id);
    return;
  }

  // Auto-unenroll if lead has replied on either channel — mark ALL track-runs for this profile skipped
  const replyCheck = db.prepare("SELECT last_replied_at, email_replied_at FROM targets WHERE id = ?").get(target.id) as { last_replied_at: string | null; email_replied_at: string | null };
  if (replyCheck?.last_replied_at || replyCheck?.email_replied_at) {
    const channel = replyCheck.email_replied_at ? "email" : "LinkedIn";
    log(db, runId, target.id, "info", `${target.full_name ?? target.linkedin_url} replied via ${channel} — unenrolling from workflow`);
    db.prepare(
      "UPDATE run_profile_tracks SET state = 'skipped', error_message = 'Lead replied' WHERE run_profile_id = ? AND state NOT IN ('completed', 'failed', 'skipped')"
    ).run(tr.run_profile_id);
    return;
  }

  const step = steps[stepIndex];
  const name = target.full_name ?? target.linkedin_url;

  try {
    if (step.step_type === "delay") {
      trAdvance(db, tr, steps);
      log(db, runId, target.id, "info", `Delay step passed for ${name}`);
      return;
    }

    if (step.step_type === "visit") {
      db.prepare("UPDATE run_profile_tracks SET last_step_at = datetime('now') WHERE id = ?").run(tr.id);
      log(db, runId, target.id, "info", `Visiting ${name}`);
      const linkedinUrl = await getLinkedinUrl(db, target, accountId);
      const page = await getSessionPage(accountId);
      let visitResult: VisitResult;
      try { visitResult = await visitProfile(page, linkedinUrl); } finally { await page.close(); }
      await saveSessionState(accountId);
      if (visitResult.degree === "first_degree" && target.degree !== 1) {
        db.prepare("UPDATE targets SET degree = 1, connected_at = COALESCE(connected_at, ?) WHERE id = ?").run(nowIso(), target.id);
        log(db, runId, target.id, "info", `${name} already 1st-degree — backfilled connection status`);
      } else if (visitResult.degree === "not_first_degree" && target.degree === 1) {
        // Self-heal a stale degree=1, mirroring the message step's reset at the
        // NotConnectedError path. Gated on the POSITIVE observation, never on
        // !isFirstDegree: "inconclusive" means the card was never inspected, so
        // clearing on it would erase a correct connection whenever the page was
        // slow, the layout drifted, or LinkedIn served an auth wall.
        db.prepare("UPDATE targets SET degree = NULL, connected_at = NULL WHERE id = ?").run(target.id);
        log(db, runId, target.id, "warn", `${name} no longer appears 1st-degree — resetting connection status`);
      }
      // messaging_urn is intentionally left alone on a reset: it is an address,
      // not authorization, and message.ts re-verifies the degree live before it
      // is ever used to address anything.
      if (visitResult.messagingUrn) {
        db.prepare("UPDATE targets SET messaging_urn = COALESCE(messaging_urn, ?) WHERE id = ?").run(visitResult.messagingUrn, target.id);
      }
      trAdvance(db, tr, steps);
      log(db, runId, target.id, "info", `Visited ${name}`);

    } else if (step.step_type === "connect") {
      if (!enforceSchedule(db, tr, runId, target.id, name, accountLimits)) return;

      const freshTarget = db.prepare("SELECT * FROM targets WHERE id = ?").get(target.id) as Target;
      if (freshTarget.degree === 1) {
        if (!freshTarget.connected_at) db.prepare("UPDATE targets SET connected_at = ? WHERE id = ?").run(nowIso(), target.id);
        log(db, runId, target.id, "info", `${name} already connected — skipping connect step`);
        trAdvance(db, tr, steps);
        return;
      }

      if (freshTarget.connection_requested_at) {
        const hoursSinceRequest = hoursSince(freshTarget.connection_requested_at);
        if (hoursSinceRequest / 24 > CONNECTION_MAX_WAIT_DAYS) {
          log(db, runId, target.id, "warn", `${name} did not accept after ${CONNECTION_MAX_WAIT_DAYS} days — skipping`);
          trSkip(db, tr, `Did not accept connection after ${CONNECTION_MAX_WAIT_DAYS} days`);
          return;
        }
        // Acceptance is detected by the daily sync-accepted job (scrolls invitation manager).
        // Runner just re-checks degree from DB — no per-profile page visits needed.
        log(db, runId, target.id, "info", `${name} not yet accepted — rechecking in ${CONNECTION_RECHECK_HOURS}h`);
        trWait(db, tr, CONNECTION_RECHECK_HOURS);
        return;
      }

      db.prepare("UPDATE run_profile_tracks SET last_step_at = datetime('now') WHERE id = ?").run(tr.id);
      log(db, runId, target.id, "info", `Sending connection request to ${name}`);
      const linkedinUrl = await getLinkedinUrl(db, target, accountId);
      const page = await getSessionPage(accountId);
      try { await sendConnectionRequest(page, linkedinUrl); } finally { await page.close().catch(() => { /* page already gone */ }); }
      // Best-effort: sendConnectionRequest only returns once verifyInvitationSent
      // has confirmed the invite is pending, so the invitation already exists. A
      // failure to refresh the session cache must not lose that fact.
      await saveSessionState(accountId).catch(e => log(db, runId, target.id, "warn", `Session cache refresh failed: ${e instanceof Error ? e.message : e}`));
      db.prepare("UPDATE targets SET connection_requested_at = ? WHERE id = ?").run(nowIso(), target.id);
      trWait(db, tr, CONNECTION_RECHECK_HOURS);
      log(db, runId, target.id, "info", `Connection request sent to ${name} — will recheck in ${CONNECTION_RECHECK_HOURS}h`);

    } else if (step.step_type === "message") {
      await ensureSalesNavEnriched(db, target, accountId);
      if (!enforceSchedule(db, tr, runId, target.id, name, accountLimits)) return;

      const freshTarget = db.prepare("SELECT * FROM targets WHERE id = ?").get(target.id) as Target;
      if (freshTarget.degree !== 1) {
        const requested = freshTarget.connection_requested_at;
        if (requested && hoursSince(requested) / 24 > CONNECTION_MAX_WAIT_DAYS) {
          log(db, runId, target.id, "warn", `${name} never accepted — skipping message step`);
          trSkip(db, tr, "Never accepted connection");
          return;
        }
        log(db, runId, target.id, "info", `${name} not yet connected — rescheduling message in ${CONNECTION_RECHECK_HOURS}h`);
        trWait(db, tr, CONNECTION_RECHECK_HOURS);
        return;
      }

      let messageText = "";
      if (step.ai_enabled) {
        if (!premium?.ai) {
          log(db, runId, target.id, "warn", `AI writer is a premium feature — not available in this build. Skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        const integration = db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter'").get() as { api_key: string } | undefined;
        const agentCfgForMsg = premium.ai.getAgentConfig();
        const resolvedMsgModel = step.ai_model || agentCfgForMsg.default_model;
        if (!integration?.api_key || !resolvedMsgModel) {
          log(db, runId, target.id, "warn", `AI enabled on message step but OpenRouter key or model missing — skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        const contactData = premium.ai.getContactWithCompany(target.id);
        if (!contactData) {
          log(db, runId, target.id, "warn", `Could not load contact data for AI message — skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        log(db, runId, target.id, "info", `Generating AI message for ${name} with ${resolvedMsgModel}`);
        const msgPosition = step.message_position ?? 1;
        let previousMessageContext: { followupNumber: number; previousMessage: string } | undefined;
        if (msgPosition > 1 && tr.last_linkedin_message) {
          previousMessageContext = { followupNumber: msgPosition - 1, previousMessage: tr.last_linkedin_message };
        }
        const result = await premium.ai.writeLinkedInMessage({
          apiKey: decryptSecret(integration.api_key)!,
          model: resolvedMsgModel,
          stepType: "message",
          stepPrompt: step.ai_prompt ?? "",
          maxWords: step.ai_max_words ?? undefined,
          language: step.ai_language ?? undefined,
          campaignPrompt: campaignPrompt ?? undefined,
          contact: contactData.contact,
          company: contactData.company,
          agentConfig: agentCfgForMsg,
          previousMessageContext,
          runId,
          targetId: target.id,
          stepId: step.id,
        });
        messageText = result.body;
      } else {
        const multiTemplateIds = (db.prepare("SELECT template_id FROM workflow_step_templates WHERE step_id = ?").all(step.id) as Array<{ template_id: string }>).map(r => r.template_id);
        if (multiTemplateIds.length > 0) {
          const randomId = multiTemplateIds[Math.floor(Math.random() * multiTemplateIds.length)];
          const tmpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(randomId) as Template | undefined;
          if (tmpl) messageText = renderTemplate(tmpl.body, freshTarget);
        } else if (step.template_id) {
          const tmpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(step.template_id) as Template | undefined;
          if (tmpl) messageText = renderTemplate(tmpl.body, freshTarget);
        }
        if (!messageText && step.message_body) messageText = renderTemplate(step.message_body, freshTarget);
      }
      if (!messageText) {
        log(db, runId, target.id, "warn", `No message body for message step — skipping ${name}`);
        trAdvance(db, tr, steps);
        return;
      }

      // ── side-effect ledger: consult BEFORE sending ──────────────────────────
      // Layer 1 is the position-keyed row; Layer 2 is the body fingerprint, which
      // catches the same message resurfacing under a renumbered position after a
      // campaign re-save. Both refuse rather than guess: a message has no
      // LinkedIn-side "already sent" signal to check, unlike an invitation.
      const stepRef = stepRefOf(step);
      const fingerprint = bodyFingerprint(messageText);
      const prior = sideEffectFor(db, tr.run_profile_id, tr.track, stepRef, "message");

      if (prior?.status === "confirmed") {
        // Convergent: a previous attempt delivered this and only the bookkeeping
        // failed. Finish the bookkeeping now instead of re-sending.
        db.prepare("UPDATE targets SET message_sent_at = COALESCE(message_sent_at, ?) WHERE id = ?").run(nowIso(), target.id);
        trRecordContext(db, tr, { linkedinMessage: messageText });
        trAdvance(db, tr, steps);
        log(db, runId, target.id, "info", `Message to ${name} was already delivered — skipping send and advancing`);
        return;
      }
      if (prior?.status === "in_flight") {
        throw new UnresolvedSideEffectError(
          `A previous attempt to message ${name} may already have been delivered (ledger ${stepRef} still in flight). ` +
          `Refusing to send again — resolve this manually before retrying.`
        );
      }
      const collision = conflictingFingerprint(db, tr.run_profile_id, tr.target_id, stepRef, fingerprint);
      if (collision) {
        throw new UnresolvedSideEffectError(
          `This exact message body was already sent to ${name} at step ${collision.step_ref} (now ${stepRef}) — ` +
          `the campaign was likely re-saved and the step renumbered. Refusing to send a duplicate.`
        );
      }
      // Commit the intent. If this insert fails, nothing is sent.
      sideEffectBegin(db, tr, stepRef, "message", fingerprint);

      db.prepare("UPDATE run_profile_tracks SET last_step_at = datetime('now') WHERE id = ?").run(tr.id);
      log(db, runId, target.id, "info", `Sending message to ${name}`);
      const messageLinkedinUrl = await getLinkedinUrl(db, target, accountId);
      const page = await getSessionPage(accountId);
      let messagingUrnResult: string | null = null;
      try {
        if (!target.full_name) throw new Error(`Target ${target.id} has no full_name — cannot search messaging`);
        const result = await sendMessage(page, target.full_name, messageText, messageLinkedinUrl, freshTarget.messaging_urn);
        messagingUrnResult = result.messagingUrn;
      } catch (err) {
        // Retract the intent ONLY for errors that provably precede the Send
        // click. Everything else stays in_flight, because a throw after the
        // click is indistinguishable here from one before it — message.ts:109
        // (`waitForTimeout` immediately after `sendBtn.click()`) can throw on a
        // dead page with the message already delivered. Marking that abandoned
        // would let Retry re-arm and send it twice, which is F1 through a new
        // door. Unrecognised errors therefore fail CLOSED, not open.
        if (isPreSendFailure(err)) {
          db.prepare("UPDATE step_side_effects SET status = 'abandoned', error_message = ? WHERE run_profile_id = ? AND track = ? AND step_ref = ? AND action = 'message'")
            .run(err instanceof Error ? err.message.slice(0, 500) : String(err), tr.run_profile_id, tr.track, stepRef);
        } else {
          db.prepare("UPDATE step_side_effects SET error_message = ? WHERE run_profile_id = ? AND track = ? AND step_ref = ? AND action = 'message'")
            .run(
              `left in_flight — may have been delivered: ${err instanceof Error ? err.message.slice(0, 400) : String(err)}`,
              tr.run_profile_id, tr.track, stepRef
            );
          log(db, runId, target.id, "warn",
            `${name}: message step failed after the compose box was reached — leaving the ledger in flight because delivery cannot be ruled out`);
        }
        if (err instanceof NotConnectedError) {
          await saveSessionState(accountId).catch(e => log(db, runId, target.id, "warn", `Session cache refresh failed: ${e instanceof Error ? e.message : e}`));
          db.prepare("UPDATE targets SET degree = NULL, connected_at = NULL WHERE id = ?").run(target.id);
          log(db, runId, target.id, "warn", `${name} no longer appears 1st-degree — resetting connection status and rescheduling`);
          trWait(db, tr, CONNECTION_RECHECK_HOURS);
          return;
        }
        throw err;
      } finally {
        await page.close().catch(() => { /* page already gone */ });
      }

      // ── past this line the message HAS been delivered ───────────────────────
      // Everything below is bookkeeping. None of it may throw out of this branch:
      // a failure here previously produced trFail with message_sent_at unset,
      // which is exactly what made Retry re-send to a real person.
      try {
        db.transaction(() => {
          db.prepare("UPDATE step_side_effects SET status = 'confirmed', confirmed_at = ? WHERE run_profile_id = ? AND track = ? AND step_ref = ? AND action = 'message'")
            .run(nowIso(), tr.run_profile_id, tr.track, stepRef);
          db.prepare("UPDATE targets SET message_sent_at = COALESCE(message_sent_at, ?) WHERE id = ?").run(nowIso(), target.id);
          if (messagingUrnResult) {
            db.prepare("UPDATE targets SET messaging_urn = COALESCE(messaging_urn, ?) WHERE id = ?").run(messagingUrnResult, target.id);
          }
        })();
        trRecordContext(db, tr, { linkedinMessage: messageText });
        trAdvance(db, tr, steps);
        log(db, runId, target.id, "info", `Message sent to ${name}`);
      } catch (bookkeepingErr) {
        log(db, runId, target.id, "error",
          `Message to ${name} WAS delivered but bookkeeping failed: ${bookkeepingErr instanceof Error ? bookkeepingErr.message : bookkeepingErr}`);
      }
      // Best-effort session cache refresh — never a reason to fail a delivered step.
      await saveSessionState(accountId).catch(e => log(db, runId, target.id, "warn", `Session cache refresh failed: ${e instanceof Error ? e.message : e}`));
      return;

    } else if (step.step_type === "sales_inmail") {
      // Sales Navigator InMail — reaches NON-connections (no degree gate), needs a
      // subject + body, costs one InMail credit. Body config mirrors the message
      // step (AI writer OR templates OR raw body); subject comes from email_subject.
      if (!premium?.inmail) {
        log(db, runId, target.id, "warn", `Sales Nav InMail is a premium feature — not available in this build. Skipping ${name}`);
        trAdvance(db, tr, steps);
        return;
      }
      await ensureSalesNavEnriched(db, target, accountId);
      if (!enforceSchedule(db, tr, runId, target.id, name, accountLimits)) return;

      const freshTarget = db.prepare("SELECT * FROM targets WHERE id = ?").get(target.id) as Target;
      if (!freshTarget.sales_nav_url) {
        log(db, runId, target.id, "warn", `${name} has no Sales Nav URL — cannot send InMail, skipping`);
        trSkip(db, tr, "No Sales Nav URL for InMail");
        return;
      }

      let inmailBody = "";
      let inmailSubject = "";
      if (step.ai_enabled) {
        if (!premium?.ai) {
          log(db, runId, target.id, "warn", `AI writer is a premium feature — not available in this build. Skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        const integration = db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter'").get() as { api_key: string } | undefined;
        const agentCfgForMsg = premium.ai.getAgentConfig();
        const resolvedMsgModel = step.ai_model || agentCfgForMsg.default_model;
        if (!integration?.api_key || !resolvedMsgModel) {
          log(db, runId, target.id, "warn", `AI enabled on InMail step but OpenRouter key or model missing — skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        const contactData = premium.ai.getContactWithCompany(target.id);
        if (!contactData) {
          log(db, runId, target.id, "warn", `Could not load contact data for AI InMail — skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        log(db, runId, target.id, "info", `Generating AI InMail for ${name} with ${resolvedMsgModel}`);
        const msgPosition = step.message_position ?? 1;
        let previousMessageContext: { followupNumber: number; previousMessage: string } | undefined;
        if (msgPosition > 1 && tr.last_linkedin_message) {
          previousMessageContext = { followupNumber: msgPosition - 1, previousMessage: tr.last_linkedin_message };
        }
        const result = await premium.ai.writeSalesInMail({
          apiKey: decryptSecret(integration.api_key)!,
          model: resolvedMsgModel,
          stepType: "sales_inmail",
          stepPrompt: step.ai_prompt ?? "",
          maxWords: step.ai_max_words ?? undefined,
          language: step.ai_language ?? undefined,
          campaignPrompt: campaignPrompt ?? undefined,
          contact: contactData.contact,
          company: contactData.company,
          agentConfig: agentCfgForMsg,
          previousMessageContext,
          runId,
          targetId: target.id,
          stepId: step.id,
        });
        inmailBody = result.body;
        inmailSubject = result.subject;
      } else {
        const multiTemplateIds = (db.prepare("SELECT template_id FROM workflow_step_templates WHERE step_id = ?").all(step.id) as Array<{ template_id: string }>).map(r => r.template_id);
        if (multiTemplateIds.length > 0) {
          const randomId = multiTemplateIds[Math.floor(Math.random() * multiTemplateIds.length)];
          const tmpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(randomId) as Template | undefined;
          if (tmpl) inmailBody = renderTemplate(tmpl.body, freshTarget);
        } else if (step.template_id) {
          const tmpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(step.template_id) as Template | undefined;
          if (tmpl) inmailBody = renderTemplate(tmpl.body, freshTarget);
        }
        if (!inmailBody && step.message_body) inmailBody = renderTemplate(step.message_body, freshTarget);
        inmailSubject = renderTemplate(step.email_subject ?? "", freshTarget).trim();
      }
      if (!inmailBody) {
        log(db, runId, target.id, "warn", `No body for InMail step — skipping ${name}`);
        trAdvance(db, tr, steps);
        return;
      }
      if (!inmailSubject) {
        log(db, runId, target.id, "warn", `No subject for InMail step (required) — skipping ${name}`);
        trAdvance(db, tr, steps);
        return;
      }

      db.prepare("UPDATE run_profile_tracks SET last_step_at = datetime('now') WHERE id = ?").run(tr.id);
      log(db, runId, target.id, "info", `Sending InMail to ${name}`);
      const page = await getSessionPage(accountId);
      try {
        await premium.inmail.sendInMail(page, freshTarget.sales_nav_url, inmailSubject, inmailBody);
      } finally {
        await page.close();
      }
      await saveSessionState(accountId);
      db.prepare("UPDATE targets SET inmail_sent_at = ?, message_sent_at = COALESCE(message_sent_at, ?) WHERE id = ?").run(nowIso(), nowIso(), target.id);
      trRecordContext(db, tr, { linkedinMessage: inmailBody });
      trAdvance(db, tr, steps);
      log(db, runId, target.id, "info", `InMail sent to ${name}`);

    } else if (step.step_type === "email") {
      await ensureApolloEnriched(db, target, runId);

      if (!emailAccountId || !emailAccountLimits) {
        log(db, runId, target.id, "warn", `Email step skipped — no email account configured on this run`);
        trAdvance(db, tr, steps);
        return;
      }

      if (!enforceSchedule(db, tr, runId, target.id, name, emailAccountLimits)) return;

      const freshTarget = db.prepare("SELECT * FROM targets WHERE id = ?").get(target.id) as Target;
      if (!freshTarget.email) {
        // No email even after Apollo enrichment — skip only this email track
        log(db, runId, target.id, "warn", `${name} has no email address — skipping email track`);
        trSkip(db, tr, "No email address found");
        return;
      }
      if (freshTarget.email_status === "invalid") {
        log(db, runId, target.id, "warn", `${name} has an invalid email address — unenrolling email track`);
        trSkip(db, tr, "Email bounced — invalid address");
        return;
      }
      if (freshTarget.company_id) {
        const company = db.prepare("SELECT email_domain_invalid FROM companies WHERE id = ?").get(freshTarget.company_id) as { email_domain_invalid: number } | undefined;
        if (company?.email_domain_invalid) {
          log(db, runId, target.id, "warn", `${name}'s company email domain is flagged invalid — unenrolling email track`);
          trSkip(db, tr, "Email domain invalid — company flagged");
          return;
        }
      }

      let emailSubject = "";
      let emailBody = "";
      if (step.ai_enabled) {
        if (!premium?.ai) {
          log(db, runId, target.id, "warn", `AI writer is a premium feature — not available in this build. Skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        const integration = db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter'").get() as { api_key: string } | undefined;
        const agentCfgForEmail = premium.ai.getAgentConfig();
        const resolvedEmailModel = step.ai_model || agentCfgForEmail.default_model;
        if (!integration?.api_key || !resolvedEmailModel) {
          log(db, runId, target.id, "warn", `AI enabled on email step but OpenRouter key or model missing — skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        const contactData = premium.ai.getContactWithCompany(target.id);
        if (!contactData) {
          log(db, runId, target.id, "warn", `Could not load contact data for AI email — skipping ${name}`);
          trAdvance(db, tr, steps);
          return;
        }
        log(db, runId, target.id, "info", `Generating AI email for ${name} with ${resolvedEmailModel}`);
        const emailPosition = step.email_position ?? 1;
        let followupContext: { followupNumber: number; previousSubject: string; previousBody: string } | undefined;
        if (emailPosition > 1 && (tr.last_email_subject || tr.last_email_body)) {
          followupContext = {
            followupNumber: emailPosition - 1,
            previousSubject: tr.last_email_subject ?? "",
            previousBody: tr.last_email_body ?? "",
          };
        }
        const result = await premium.ai.writeEmail({
          apiKey: decryptSecret(integration.api_key)!,
          model: resolvedEmailModel,
          stepType: "email",
          stepPrompt: step.ai_prompt ?? "",
          maxWords: step.ai_max_words ?? undefined,
          language: step.ai_language ?? undefined,
          campaignPrompt: campaignPrompt ?? undefined,
          contact: contactData.contact,
          company: contactData.company,
          agentConfig: agentCfgForEmail,
          followupContext,
          replyContext: tr.pending_reply_context ?? undefined,
          runId,
          targetId: target.id,
          stepId: step.id,
        });
        emailSubject = result.subject;
        emailBody = result.body;
        // One-shot: consume the OOO reply context so later follow-ups don't re-acknowledge it
        if (tr.pending_reply_context) {
          db.prepare("UPDATE run_profile_tracks SET pending_reply_context = NULL WHERE id = ?").run(tr.id);
        }
      } else {
        emailSubject = renderTemplate(step.email_subject ?? "", freshTarget);
        emailBody = renderTemplate(step.email_body ?? "", freshTarget);
      }

      if (!emailBody) {
        log(db, runId, target.id, "warn", `No email body for email step — skipping ${name}`);
        trAdvance(db, tr, steps);
        return;
      }

      const emailAccount = db.prepare("SELECT * FROM email_accounts WHERE id = ?").get(emailAccountId) as {
        id: string; from_email: string; from_name: string | null; reply_to: string | null;
        smtp_host: string; smtp_port: number; smtp_secure: number;
        username: string; password: string; signature: string | null;
      } | undefined;

      if (!emailAccount) {
        log(db, runId, target.id, "error", `Email account ${emailAccountId} not found`);
        trFail(db, tr, "Email account missing");
        return;
      }

      // Last-line-of-defense: re-check the daily limit for this email account against ground-truth
      // (matched by run_profiles.email_account_id, the actual sender). If any prior gate is buggy,
      // this catches the overshoot and reschedules instead of sending.
      const sentTodayActual = (db.prepare(
        `SELECT COUNT(*) as c FROM logs l
         WHERE l.message LIKE 'Email sent%'
         AND date(l.created_at) = date('now')
         AND EXISTS (
           SELECT 1 FROM run_profiles rp
           WHERE rp.run_id = l.run_id AND rp.target_id = l.target_id
           AND rp.email_account_id = ?
         )`
      ).get(emailAccountId) as { c: number }).c;
      const hardLimit = effectiveEmailLimit(emailAccountLimits);
      if (sentTodayActual >= hardLimit) {
        log(db, runId, target.id, "warn", `Daily limit guard tripped for ${emailAccountId} (${sentTodayActual}/${hardLimit}) — rescheduling ${name} to tomorrow`);
        trReschedule(db, tr, rescheduleToTomorrow(emailAccountLimits));
        return;
      }

      // Step-level signature takes precedence; null means fall back to email account default
      const sig = (step.email_signature !== null ? step.email_signature : emailAccount.signature)?.trim();
      const finalEmailBody = sig ? `${emailBody}\n\n--\n${sig}` : emailBody;
      db.prepare("UPDATE run_profile_tracks SET last_step_at = datetime('now') WHERE id = ?").run(tr.id);
      log(db, runId, target.id, "info", `Sending email to ${name} <${freshTarget.email}>`);
      await sendEmail({ ...emailAccount, password: decryptSecret(emailAccount.password)! }, freshTarget.email, emailSubject, finalEmailBody);
      trRecordContext(db, tr, { emailSubject, emailBody });
      trAdvance(db, tr, steps);
      log(db, runId, target.id, "info", `Email sent to ${name}`);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof WeeklyLimitError) {
      log(db, runId, target.id, "error", `Weekly connection limit reached — pausing run`);
      db.prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(runId);
      return;
    }
    if (err instanceof AlreadyConnectedError) {
      log(db, runId, target.id, "info", `${name} already connected — advancing`);
      db.prepare("UPDATE targets SET degree = 1, connected_at = COALESCE(connected_at, ?) WHERE id = ?").run(nowIso(), target.id);
      trAdvance(db, tr, steps);
      return;
    }
    if (err instanceof PendingInviteError) {
      // LinkedIn already holds the invite, so the send must NOT be retried —
      // this is the recovery path for a process that died between the invite
      // landing and connection_requested_at being written. Recording it here
      // makes the retry a no-op instead of a duplicate invite.
      log(db, runId, target.id, "info", `${name} invite already pending — will recheck`);
      // COALESCE rather than a JS null-check on `target`: that row was read
      // before the send, so the column may have been written since. Stamping
      // in SQL keeps the original request time instead of overwriting it.
      db.prepare(
        "UPDATE targets SET connection_requested_at = COALESCE(connection_requested_at, ?) WHERE id = ?"
      ).run(nowIso(), target.id);
      trWait(db, tr, CONNECTION_RECHECK_HOURS);
      return;
    }
    if (msg.includes("No InMail credits left")) {
      inmailCreditsExhaustedOn[accountId] = todayLocalDate();
      const slot = rescheduleToTomorrow(accountLimits);
      log(db, runId, target.id, "warn", `No InMail credits left on this account — pausing InMail sends until tomorrow, rescheduled ${name} to ${slot}`);
      trReschedule(db, tr, slot);
      return;
    }
    // Last specific branch before the catch-all. Placed here deliberately: the
    // four branches above must keep their existing routing, and the InMail check
    // above matches on SUBSTRING, so this error's message must never contain
    // "No InMail credits left" or it would be captured there instead.
    if (err instanceof UnresolvedSideEffectError) {
      log(db, runId, target.id, "error", `${name}: ${msg}`);
      trFail(db, tr, msg);
      return;
    }
    log(db, runId, target.id, "error", `Error on ${name}: ${msg}`);
    trFail(db, tr, msg);
  }
}

// ─── global loop ─────────────────────────────────────────────────────────────

const g = global as typeof global & { __linkiRunner?: { loop: Promise<void> | null; attempts: number } };

/**
 * Starts the global loop, and can revive it after a fatal failure.
 *
 * The previous boolean latched: it was set BEFORE the only unguarded call in
 * globalLoop (getDb, which throws on a corrupt DB or a missing NEXTAUTH_SECRET)
 * and never reset, so once the loop died nothing in the process could restart it
 * — not this function, not POST /api/runs/[id]/start. Only a process restart.
 * Holding the in-flight promise distinguishes "never started" from "not running"
 * and makes recovery possible.
 *
 * Concurrency: the promise IS the mutex. A self-heal retry already in flight and
 * a concurrent caller both observe the same non-null `loop`, so exactly one loop
 * can exist however many callers race.
 */
export function ensureGlobalRunnerStarted(): void {
  const state = (g.__linkiRunner ??= { loop: null, attempts: 0 });
  if (state.loop) return;
  state.loop = runLoopWithRecovery().finally(() => { state.loop = null; });
}

/** Observable liveness for tests, without reaching into module internals. */
export function runnerState(): { running: boolean; attempts: number } {
  return { running: !!g.__linkiRunner?.loop, attempts: g.__linkiRunner?.attempts ?? 0 };
}

/**
 * How stale the progress marker may be before the watchdog treats the runner as
 * dead. Must match LIVENESS_THRESHOLD_MS in pages/api/health.ts — both are
 * derived from the timeout budget in docs/phase1-baseline.md (worst single step
 * ~345s + randomDelay <=20s = ~365s, with ~64% margin).
 */
export const WATCHDOG_STALE_MS = 600_000;
const WATCHDOG_INTERVAL_MS = 60_000;

/**
 * Polls liveness and revives a dead loop.
 *
 * Phase 1 made the loop retry its one known fatal path (getDb) and made
 * liveness observable, but nothing POLLED it: ensureGlobalRunnerStarted has
 * exactly two callers — instrumentation at boot and runs/[id]/start on operator
 * action — and neither runs on a timer (NF-6). A loop that exits for any other
 * reason therefore waits for a human.
 *
 * INVARIANT — this is why it is safe to revive automatically:
 * a fresh progress marker means a step is advancing, because markers are written
 * at every executeStep boundary, after the accepted-connections sync, and at
 * loop-iteration start. So "marker older than WATCHDOG_STALE_MS" cannot mean
 * "busy"; it can only mean the loop is not running. The watchdog never races
 * live LinkedIn work.
 *
 * Returns whether it intervened, so the behaviour is testable without timers.
 */
export function runnerWatchdogTick(db: ReturnType<typeof getDb>): boolean {
  try {
    if (runnerState().running) return false;          // a loop (or its retry) is alive
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(HEARTBEAT_KEYS.progressAt) as { value: string } | undefined;
    const ageMs = row?.value ? Date.now() - new Date(row.value).getTime() : Infinity;
    if (ageMs <= WATCHDOG_STALE_MS) return false;     // progressing — never intervene

    const prev = db.prepare("SELECT value FROM app_settings WHERE key = 'runner_revivals'").get() as { value: string } | undefined;
    const count = (parseInt(prev?.value ?? "0", 10) || 0) + 1;
    putSetting(db, "runner_revivals", String(count));
    console.warn(`[runner] watchdog: progress marker is ${Math.round(ageMs / 1000)}s old — reviving the loop (revival #${count})`);
    ensureGlobalRunnerStarted();
    return true;
  } catch (err) {
    // A watchdog that can throw is a liability, not a safety net.
    console.warn("[runner] watchdog tick failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

const gw = global as typeof global & { __linkiWatchdog?: NodeJS.Timeout };

/**
 * Registered at boot next to the runner, on a timer INDEPENDENT of the loop so
 * it survives the loop's death. unref'd, following lib/update-check.ts: a
 * watchdog must never be the reason a process cannot exit.
 *
 * PRECONDITION — SINGLE PROCESS. The loop guard is a per-process global. This
 * watchdog actively re-establishes loops, so a second Node process (cluster
 * mode, PM2, replicas, or a second container on the same /data volume) yields
 * two loops and two Chromium stacks driving one LinkedIn account. Verified today
 * as one `next-server` process; see NF-7 in docs/audit-corrections.md and the
 * precondition section of docs/operations.md before scaling anything.
 */
export function startRunnerWatchdog(): void {
  if (gw.__linkiWatchdog) return;
  gw.__linkiWatchdog = nodeSetInterval(() => {
    try { runnerWatchdogTick(getDb()); } catch { /* never propagate */ }
  }, WATCHDOG_INTERVAL_MS);
  gw.__linkiWatchdog.unref();
}

const RECOVERY_BACKOFF_MS = [30_000, 60_000, 120_000];
const QUIET_AFTER_ATTEMPTS = 5;

/**
 * Wraps globalLoop so a fatal acquisition failure self-heals instead of ending
 * the runner. Backoff is capped, and a deterministic fault (a missing
 * NEXTAUTH_SECRET fails identically forever) must not spin loudly: past
 * QUIET_AFTER_ATTEMPTS the log drops to one line per ten attempts and the cause
 * is surfaced through /api/health's reason field instead of a scrolling wall.
 */
async function runLoopWithRecovery(): Promise<void> {
  const state = (g.__linkiRunner ??= { loop: null, attempts: 0 });
  for (;;) {
    try {
      await globalLoop();
      state.attempts = 0;
      return;
    } catch (err) {
      state.attempts++;
      const wait = RECOVERY_BACKOFF_MS[Math.min(state.attempts - 1, RECOVERY_BACKOFF_MS.length - 1)];
      if (state.attempts <= QUIET_AFTER_ATTEMPTS) {
        console.error(`[runner] Global loop crashed (attempt ${state.attempts}), retrying in ${wait / 1000}s:`,
          err instanceof Error ? err.message : err);
      } else if (state.attempts % 10 === 0) {
        console.error(`[runner] Global loop still failing after ${state.attempts} attempts: ${err instanceof Error ? err.constructor.name : typeof err}`);
      }
      await sleepUnref(wait);
    }
  }
}

async function globalLoop(): Promise<void> {
  console.log("[runner] Global loop started");
  const db = getDb();

  while (true) {
    recordProgress(db, "loop");
    try {
      await tick(db);
      recordTickOutcome(db, null);
    } catch (err) {
      recordTickOutcome(db, err);
      console.error("[runner] Tick error:", err instanceof Error ? err.message : err);
    }
    try {
      const { processScheduledImports } = await import("@/lib/import-jobs");
      await processScheduledImports(db);
    } catch (err) {
      console.error("[runner] Import scheduler error:", err instanceof Error ? err.message : err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function tick(db: ReturnType<typeof getDb>): Promise<void> {
  const activeRuns = db.prepare(`
    SELECT r.id as run_id, r.workflow_id, r.account_id, r.email_account_id,
           a.daily_connection_limit, a.daily_message_limit, a.daily_inmail_limit,
           a.active_hours_start, a.active_hours_end, a.timezone, a.working_days
    FROM runs r
    JOIN accounts a ON a.id = r.account_id
    WHERE r.status = 'running' AND a.is_authenticated = 1
  `).all() as Array<{ run_id: string; workflow_id: string; account_id: string; email_account_id: string | null } & AccountLimits>;

  if (activeRuns.length === 0) return;

  console.log(`[runner] Tick — ${activeRuns.length} active run(s)`);

  const seenAccounts = new Set<string>();
  for (const run of activeRuns) {
    if (seenAccounts.has(run.account_id)) continue;
    seenAccounts.add(run.account_id);
  }

  // Daily sync: stamp accepted connections from invitation manager (once per 23h per account)
  for (const accountId of seenAccounts) {
    if (shouldSyncAccepted(accountId)) {
      try {
        console.log(`[runner] Starting accepted-connections sync for account ${accountId}`);
        const stamped = await syncAcceptedConnections(accountId);
        if (stamped > 0) {
          for (const r of activeRuns.filter(x => x.account_id === accountId)) {
            log(db, r.run_id, null, "info", `Accepted-connections sync: ${stamped} contact${stamped === 1 ? "" : "s"} marked as connected`);
          }
        }
        console.log(`[runner] Accepted-connections sync complete — ${stamped} stamped`);
        recordProgress(db, "sync-accepted");
      } catch (e) {
        console.warn("[runner] Accepted-connections sync error:", e instanceof Error ? e.message : e);
      }
    }
  }

  // LinkedIn inbox reply detection (messaging GraphQL) — once per 15min per
  // account. Sets targets.last_replied_at so the runner auto-unenrolls repliers.
  // LinkedIn reply detection is a premium feature (AI classifier layer) — no-op without ee/.
  for (const accountId of seenAccounts) {
    if (premium?.replies?.shouldSyncInbox(accountId)) {
      try {
        console.log(`[runner] Starting LinkedIn inbox sync for account ${accountId}`);
        const replies = await premium.replies.syncAccountInbox(accountId);
        console.log(`[runner] LinkedIn inbox sync complete — ${replies} new repl${replies === 1 ? "y" : "ies"}`);
        if (replies > 0) {
          for (const r of activeRuns.filter(x => x.account_id === accountId)) {
            log(db, r.run_id, null, "info", `LinkedIn inbox sync: ${replies} new repl${replies === 1 ? "y" : "ies"} detected`);
          }
        }
      } catch (e) {
        console.warn("[runner] LinkedIn inbox sync error:", e instanceof Error ? e.message : e);
      }
    }
  }

  // Sync email IMAP inboxes for each unique email account in active run profiles
  const activeRunIds = activeRuns.map(r => r.run_id);
  const activeEmailAccountIds: string[] = activeRunIds.length > 0
    ? [...new Set(
        (db.prepare(
          `SELECT DISTINCT rp.email_account_id FROM run_profiles rp
           JOIN run_profile_tracks rt ON rt.run_profile_id = rp.id
           WHERE rp.run_id IN (${activeRunIds.map(() => "?").join(",")})
           AND rp.email_account_id IS NOT NULL
           AND rt.state NOT IN ('completed', 'failed', 'skipped')`
        ).all(...activeRunIds) as { email_account_id: string }[]).map(r => r.email_account_id)
      )]
    : [];

  const seenEmailAccounts = new Set<string>();
  for (const emailAccId of activeEmailAccountIds) {
    if (seenEmailAccounts.has(emailAccId)) continue;
    seenEmailAccounts.add(emailAccId);
    if (shouldSyncEmailInbox(emailAccId)) {
      try {
        console.log(`[runner] Starting IMAP sync for email account ${emailAccId}`);
        const { replies, bounces } = await syncEmailInbox(emailAccId);
        console.log(`[runner] IMAP sync complete — ${replies} replies, ${bounces} bounces`);
        for (const runId of activeRunIds) {
          if (replies > 0) log(db, runId, null, "info", `Email inbox sync: ${replies} new repl${replies === 1 ? "y" : "ies"} detected`);
          if (bounces > 0) log(db, runId, null, "warn", `Email inbox sync: ${bounces} bounce${bounces === 1 ? "" : "s"} detected — contacts marked invalid and unenrolled`);
        }
      } catch (e) {
        console.warn("[runner] Email inbox sync error:", e instanceof Error ? e.message : e);
      }
      // Space out back-to-back IMAP syncs — a 20-account burst with zero gap
      // between them held the host busy for minutes straight (Jul 2026 incident).
      await sleep(2000);
    }
  }

  // Auto-complete runs where ALL track-runs across all profiles are terminal
  for (const run of activeRuns) {
    const remaining = (db.prepare(
      `SELECT COUNT(*) as c FROM run_profile_tracks rt
       JOIN run_profiles rp ON rp.id = rt.run_profile_id
       WHERE rp.run_id = ? AND rt.state NOT IN ('completed', 'failed', 'skipped')`
    ).get(run.run_id) as { c: number }).c;
    if (remaining === 0) {
      db.prepare("UPDATE runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(run.run_id);
      log(db, run.run_id, null, "info", "All profiles processed — run completed");
    }
  }

  // Re-load active runs after potential completions
  const stillActive = db.prepare(`
    SELECT r.id as run_id, r.workflow_id, r.account_id, r.email_account_id,
           a.daily_connection_limit, a.daily_message_limit, a.daily_inmail_limit,
           a.active_hours_start, a.active_hours_end, a.timezone, a.working_days
    FROM runs r
    JOIN accounts a ON a.id = r.account_id
    WHERE r.status = 'running'
  `).all() as Array<{ run_id: string; workflow_id: string; account_id: string; email_account_id: string | null } & AccountLimits>;

  if (stillActive.length === 0) return;

  const accountLimitsMap = new Map<string, AccountLimits>();
  for (const run of stillActive) {
    if (!accountLimitsMap.has(run.account_id)) accountLimitsMap.set(run.account_id, run);
  }

  // Build email account limits map
  const stillActiveRunIds = stillActive.map(r => r.run_id);
  const emailAccountIds: string[] = stillActiveRunIds.length > 0
    ? [...new Set(
        (db.prepare(
          `SELECT DISTINCT rp.email_account_id FROM run_profiles rp
           WHERE rp.run_id IN (${stillActiveRunIds.map(() => "?").join(",")})
           AND rp.email_account_id IS NOT NULL`
        ).all(...stillActiveRunIds) as { email_account_id: string }[]).map(r => r.email_account_id)
      )]
    : [];
  const emailAccountLimitsMap = new Map<string, EmailAccountLimits>();
  for (const emailAccountId of emailAccountIds) {
    const ea = db.prepare("SELECT daily_email_limit, active_hours_start, active_hours_end, timezone, working_days, ramp_up_enabled, ramp_start_date FROM email_accounts WHERE id = ?").get(emailAccountId) as EmailAccountLimits | undefined;
    if (ea) emailAccountLimitsMap.set(emailAccountId, ea);
  }

  // Count actions already done today per LinkedIn account — messages and InMail are
  // counted separately so a busy message quota never starves InMail sends (and vice versa).
  const connectsSentToday = new Map<string, number>();
  const messagesSentToday = new Map<string, number>();
  const inmailsSentToday = new Map<string, number>();
  for (const [accountId] of accountLimitsMap) {
    const c = (db.prepare(
      `SELECT COUNT(*) as c FROM logs WHERE run_id IN (SELECT id FROM runs WHERE account_id = ?)
       AND message LIKE 'Connection request sent%' AND date(created_at) = date('now')`
    ).get(accountId) as { c: number }).c;
    const m = (db.prepare(
      `SELECT COUNT(*) as c FROM logs WHERE run_id IN (SELECT id FROM runs WHERE account_id = ?)
       AND message LIKE 'Message sent%' AND date(created_at) = date('now')`
    ).get(accountId) as { c: number }).c;
    const im = (db.prepare(
      `SELECT COUNT(*) as c FROM logs WHERE run_id IN (SELECT id FROM runs WHERE account_id = ?)
       AND message LIKE 'InMail sent%' AND date(created_at) = date('now')`
    ).get(accountId) as { c: number }).c;
    connectsSentToday.set(accountId, c);
    messagesSentToday.set(accountId, m);
    inmailsSentToday.set(accountId, im);
  }

  // Count emails sent today per email account — match by run_profiles.email_account_id
  // (the actual sending account), not runs.email_account_id (which may differ when accounts rotate)
  const emailsSentToday = new Map<string, number>();
  for (const emailAccountId of emailAccountIds) {
    const e = (db.prepare(
      `SELECT COUNT(*) as c FROM logs l
       WHERE l.message LIKE 'Email sent%'
       AND date(l.created_at) = date('now')
       AND EXISTS (
         SELECT 1 FROM run_profiles rp
         WHERE rp.run_id = l.run_id AND rp.target_id = l.target_id
         AND rp.email_account_id = ?
       )`
    ).get(emailAccountId) as { c: number }).c;
    emailsSentToday.set(emailAccountId, e);
  }

  // Steps cache: (workflow_id, track) → steps filtered by that track
  const stepsCache = new Map<string, WorkflowStep[]>();
  const getSteps = (workflowId: string, track: string): WorkflowStep[] => {
    const key = `${workflowId}|${track}`;
    if (!stepsCache.has(key)) {
      stepsCache.set(key, db.prepare(
        "SELECT * FROM workflow_steps WHERE workflow_id = ? AND track = ? ORDER BY step_order"
      ).all(workflowId, track) as WorkflowStep[]);
    }
    return stepsCache.get(key)!;
  };

  // Workflow prompt cache: workflow_id → campaign prompt string (or null)
  const workflowPromptCache = new Map<string, string | null>();
  const getWorkflowPrompt = (workflowId: string): string | null => {
    if (!workflowPromptCache.has(workflowId)) {
      const row = db.prepare("SELECT prompt FROM workflows WHERE id = ?").get(workflowId) as { prompt: string | null } | undefined;
      workflowPromptCache.set(workflowId, row?.prompt ?? null);
    }
    return workflowPromptCache.get(workflowId) ?? null;
  };

  // Collect ALL due track-runs across all active runs, oldest-due first
  const runIds = stillActive.map(r => r.run_id);
  const placeholders = runIds.map(() => "?").join(",");
  const dueTrackRuns = db.prepare(
    `SELECT rt.id, rt.run_profile_id, rt.track, rt.state, rt.current_step, rt.next_step_at,
            rt.error_message, rt.last_email_subject, rt.last_email_body, rt.last_linkedin_message,
            rt.pending_reply_context,
            rp.run_id, rp.target_id, rp.email_account_id,
            r.account_id, r.workflow_id,
            t.connection_requested_at
     FROM run_profile_tracks rt
     JOIN run_profiles rp ON rp.id = rt.run_profile_id
     JOIN runs r ON r.id = rp.run_id
     JOIN targets t ON t.id = rp.target_id
     WHERE rp.run_id IN (${placeholders})
       AND rt.state = 'in_progress'
       AND (rt.next_step_at IS NULL OR datetime(rt.next_step_at) <= datetime('now'))
     ORDER BY rt.next_step_at ASC`
  ).all(...runIds) as TrackRun[];

  // Enroll new pending track-runs — track remaining slots per account across runs.
  // Enrollment (pending -> in_progress) happens exactly once per track-run, on its
  // FIRST linkedin-track step, so the budget it draws from must match that step's
  // type — a workflow can open on "connect" (e.g. connect -> message) or on
  // "sales_inmail" (e.g. an InMail-first campaign), and each type has its own daily cap.
  const connectSlotsRemaining = new Map<string, number>();
  const inmailSlotsRemaining = new Map<string, number>();
  const firstLinkedinStepCache = new Map<string, string | undefined>();
  const getFirstLinkedinStepType = (workflowId: string): string | undefined => {
    if (!firstLinkedinStepCache.has(workflowId)) {
      const row = db.prepare(
        "SELECT step_type FROM workflow_steps WHERE workflow_id = ? AND track = 'linkedin' ORDER BY step_order LIMIT 1"
      ).get(workflowId) as { step_type: string } | undefined;
      firstLinkedinStepCache.set(workflowId, row?.step_type);
    }
    return firstLinkedinStepCache.get(workflowId);
  };
  const enrolledEmailPairs = new Set<string>();
  for (const run of stillActive) {
    const limits = accountLimitsMap.get(run.account_id)!;
    const firstStepType = getFirstLinkedinStepType(run.workflow_id);
    const isInmailFirst = firstStepType === "sales_inmail";
    const slotsRemaining = isInmailFirst ? inmailSlotsRemaining : connectSlotsRemaining;

    // LinkedIn track enrollment — each run gets its own enrollment, but all runs
    // for the same account share the daily slot budget for that action type
    if (!slotsRemaining.has(run.account_id)) {
      const dailyLimit = isInmailFirst ? (limits.daily_inmail_limit ?? 15) : (limits.daily_connection_limit ?? 20);
      const sentToday = isInmailFirst
        ? (inmailsSentToday.get(run.account_id) ?? 0)
        : (connectsSentToday.get(run.account_id) ?? 0);
      const actionsLeft = Math.max(0, dailyLimit - sentToday);
      const firstStepTypeSql = isInmailFirst ? "'sales_inmail'" : "'connect'";
      const scheduledToday = (db.prepare(
        `SELECT COUNT(*) as c FROM run_profile_tracks rt
         JOIN run_profiles rp ON rp.id = rt.run_profile_id
         JOIN runs r ON r.id = rp.run_id
         JOIN workflow_steps ws ON ws.workflow_id = r.workflow_id AND ws.track = 'linkedin' AND ws.step_order = 1
         WHERE r.account_id = ? AND rt.track = 'linkedin' AND rt.state = 'in_progress'
         AND ws.step_type = ${firstStepTypeSql}
         AND date(datetime(rt.next_step_at)) = date('now')`
      ).get(run.account_id) as { c: number }).c;
      slotsRemaining.set(run.account_id, Math.max(0, actionsLeft - scheduledToday));
    }
    const slotsLeft = slotsRemaining.get(run.account_id)!;
    if (slotsLeft > 0) {
      const toEnroll = Math.min(slotsLeft, 5);
      const pending = db.prepare(
        `SELECT rt.id, rt.run_profile_id, rt.track FROM run_profile_tracks rt
         JOIN run_profiles rp ON rp.id = rt.run_profile_id
         WHERE rp.run_id = ? AND rt.track = 'linkedin' AND rt.state = 'pending'
         ORDER BY rt.id LIMIT ?`
      ).all(run.run_id, toEnroll) as Array<{ id: string; run_profile_id: string; track: string }>;
      spreadEnrollBatch(db, run.run_id, pending, limits, "linkedin");
      slotsRemaining.set(run.account_id, slotsLeft - pending.length);
    }

    // Email track enrollment — iterate per actual sending account used by this run's profiles
    // (run_profiles.email_account_id may differ from runs.email_account_id when accounts are rotated)
    const runEmailAccountIds = (db.prepare(
      `SELECT DISTINCT rp.email_account_id FROM run_profiles rp
       WHERE rp.run_id = ? AND rp.email_account_id IS NOT NULL`
    ).all(run.run_id) as { email_account_id: string }[]).map(r => r.email_account_id);

    for (const emailAccId of runEmailAccountIds) {
      const emailKey = `${run.run_id}|${emailAccId}|email`;
      if (!enrolledEmailPairs.has(emailKey)) {
        enrolledEmailPairs.add(emailKey);
        const emailLimits = emailAccountLimitsMap.get(emailAccId);
        if (emailLimits) {
          const effectiveLimit = effectiveEmailLimit(emailLimits);
          const emailsLeft = Math.max(0, effectiveLimit - (emailsSentToday.get(emailAccId) ?? 0));
          const emailScheduledToday = (db.prepare(
            `SELECT COUNT(*) as c FROM run_profile_tracks rt
             JOIN run_profiles rp ON rp.id = rt.run_profile_id
             WHERE rp.email_account_id = ? AND rt.track = 'email' AND rt.state = 'in_progress'
             AND date(datetime(rt.next_step_at)) = date('now')`
          ).get(emailAccId) as { c: number }).c;
          const emailSlotsLeft = Math.max(0, emailsLeft - emailScheduledToday);
          if (emailSlotsLeft > 0) {
            const pendingEmail = db.prepare(
              `SELECT rt.id, rt.run_profile_id, rt.track FROM run_profile_tracks rt
               JOIN run_profiles rp ON rp.id = rt.run_profile_id
               WHERE rp.run_id = ? AND rp.email_account_id = ? AND rt.track = 'email' AND rt.state = 'pending'
               ORDER BY rt.id LIMIT ?`
            ).all(run.run_id, emailAccId, Math.min(emailSlotsLeft, 5)) as Array<{ id: string; run_profile_id: string; track: string }>;
            spreadEnrollBatch(db, run.run_id, pendingEmail, emailLimits, "email");
          }
        }
      }
    }
  }

  if (dueTrackRuns.length === 0) return;

  // Apply daily limits — separate due track-runs into execute vs reschedule
  const toExecute: TrackRun[] = [];
  const toReschedule: TrackRun[] = [];

  const connectsPlanned = new Map<string, number>(Array.from(accountLimitsMap.keys()).map(id => [id, 0]));
  const messagesPlanned = new Map<string, number>(Array.from(accountLimitsMap.keys()).map(id => [id, 0]));
  const inmailsPlanned = new Map<string, number>(Array.from(accountLimitsMap.keys()).map(id => [id, 0]));
  const emailsPlanned = new Map<string, number>(emailAccountIds.map(id => [id, 0]));

  for (const tr of dueTrackRuns) {
    const steps = getSteps(tr.workflow_id, tr.track);
    const stepIndex = tr.current_step;
    if (stepIndex >= steps.length) { toExecute.push(tr); continue; }
    const step = steps[stepIndex];
    const limits = accountLimitsMap.get(tr.account_id)!;

    if (step.step_type === "connect") {
      // A connect step is "due" both when it's about to send a NEW request and when
      // it's just rechecking an already-sent one for acceptance (see the `degree === 1`
      // check in executeStep). Only the former spends a daily connect slot — the recheck
      // is a free DB read and must never be blocked by the cap, or an accepted connection
      // can never hand off to the next step (it'd be rescheduled behind new sends forever).
      if (tr.connection_requested_at) {
        toExecute.push(tr);
        continue;
      }
      const sentToday = connectsSentToday.get(tr.account_id) ?? 0;
      const planned = connectsPlanned.get(tr.account_id) ?? 0;
      if (sentToday + planned >= (limits.daily_connection_limit ?? 20)) {
        toReschedule.push(tr);
      } else {
        connectsPlanned.set(tr.account_id, planned + 1);
        toExecute.push(tr);
      }
    } else if (step.step_type === "message") {
      const sentToday = messagesSentToday.get(tr.account_id) ?? 0;
      const planned = messagesPlanned.get(tr.account_id) ?? 0;
      if (sentToday + planned >= (limits.daily_message_limit ?? 50)) {
        toReschedule.push(tr);
      } else {
        messagesPlanned.set(tr.account_id, planned + 1);
        toExecute.push(tr);
      }
    } else if (step.step_type === "sales_inmail") {
      const sentToday = inmailsSentToday.get(tr.account_id) ?? 0;
      const planned = inmailsPlanned.get(tr.account_id) ?? 0;
      if (inmailCreditsExhaustedToday(tr.account_id) || sentToday + planned >= (limits.daily_inmail_limit ?? 15)) {
        toReschedule.push(tr);
      } else {
        inmailsPlanned.set(tr.account_id, planned + 1);
        toExecute.push(tr);
      }
    } else if (step.step_type === "email") {
      const profileEmailAccountId = tr.email_account_id;
      if (!profileEmailAccountId) {
        toExecute.push(tr);
      } else {
        const emailLimits = emailAccountLimitsMap.get(profileEmailAccountId);
        const sentToday = emailsSentToday.get(profileEmailAccountId) ?? 0;
        const planned = emailsPlanned.get(profileEmailAccountId) ?? 0;
        const effectiveLimit = emailLimits ? effectiveEmailLimit(emailLimits) : 50;
        if (sentToday + planned >= effectiveLimit) {
          toReschedule.push(tr);
        } else {
          emailsPlanned.set(profileEmailAccountId, planned + 1);
          toExecute.push(tr);
        }
      }
    } else {
      // visit, delay — no limit
      toExecute.push(tr);
    }
  }

  // Reschedule overflow to tomorrow (use LinkedIn account schedule for reschedule)
  for (const tr of toReschedule) {
    const limits = accountLimitsMap.get(tr.account_id)!;
    const slot = rescheduleToTomorrow(limits);
    db.prepare("UPDATE run_profile_tracks SET next_step_at = ? WHERE id = ?").run(slot, tr.id);
    log(db, tr.run_id, tr.target_id, "info", `Daily limit reached — rescheduled to ${slot}`);
  }

  // Execute what's left
  for (const tr of toExecute) {
    const steps = getSteps(tr.workflow_id, tr.track);
    const limits = accountLimitsMap.get(tr.account_id)!;
    const emailAccountId = tr.email_account_id ?? null;
    const emailLimits = emailAccountId ? (emailAccountLimitsMap.get(emailAccountId) ?? null) : null;

    const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get(tr.run_id) as { status: string } | undefined;
    if (!runStatus || runStatus.status !== "running") continue;

    // Claim it before any work happens — another runner may have taken this
    // same row out of its own due-query since ours ran.
    if (!trClaim(db, tr.id)) continue;

    const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(tr.target_id) as Target;
    // Boundary markers only — deliberately NOT inside connect.ts/visit.ts/
    // message.ts. The worst gap is one step (~345s) plus randomDelay (<=20s),
    // which the 600s liveness threshold covers with margin; buying a few more
    // minutes is not worth instrumenting the components the audit rated highest.
    recordProgress(db, `step:${tr.track}:start`);
    await executeStep(db, tr.run_id, tr, target, steps, tr.account_id, limits, emailAccountId, emailLimits, getWorkflowPrompt(tr.workflow_id));
    recordProgress(db, `step:${tr.track}:done`);
    await randomDelay(PROFILE_DELAY_MIN, PROFILE_DELAY_MAX);
  }
}

export function spreadEnrollBatch(
  db: ReturnType<typeof getDb>,
  runId: string,
  pending: Array<{ id: string; run_profile_id: string; track: string }>,
  limits: ScheduleConfig,
  track: string,
  /** Injected only by tests, so slots are assertable without the real clock. */
  opts: { now?: Date; random?: () => number } = {}
) {
  const batchSize = pending.length;
  if (batchSize === 0) return;
  const now = opts.now ?? new Date();
  const rand = opts.random ?? Math.random;
  const tz = limits.timezone || "UTC";
  const start = limits.active_hours_start ?? 9;
  const end = limits.active_hours_end ?? 18;
  const { hour, minute } = getLocalParts(tz, now);
  const nowFrac = hour + minute / 60;
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);

  const getDatePart = (type: string) =>
    dateParts.find(p => p.type === type)?.value ?? "0";

  const year = parseInt(getDatePart("year"), 10);
  const month = parseInt(getDatePart("month"), 10);
  const day = parseInt(getDatePart("day"), 10);
  const dayStartMs = zonedDateTimeToUtc(year, month, day, start, 0, tz).getTime();
  const dayEndMs = zonedDateTimeToUtc(year, month, day, end, 0, tz).getTime();

  // Buckets are laid out from whichever is LATER: the window's start, or now.
  //
  // Anchoring them to today's active_hours_start meant a batch enrolled partway
  // through the window drew slots that had already passed, so every such contact
  // became due on the very next tick — precisely the burst the spreading exists
  // to prevent (verified Aug 2026: enrolled 14:06:38 into a 09:00-18:00 window,
  // executed 14:07:08). Re-basing divides the time that is actually LEFT in the
  // day among the batch, so slots are always >= now and still spread out.
  //
  // Enrolling before the window opens is unaffected: dayStartMs wins, and the
  // distribution is identical to before.
  const spreadStartMs = Math.max(dayStartMs, now.getTime());
  const bucketMs = Math.max(0, dayEndMs - spreadStartMs) / batchSize;

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    const claimed = db.prepare(
      "UPDATE run_profile_tracks SET state = 'in_progress' WHERE id = ? AND state = 'pending'"
    ).run(row.id);
    if (claimed.changes === 0) continue;
    const slot = (() => {
      if (nowFrac >= end - 0.25) return rescheduleToTomorrow(limits);
      const bucketStart = spreadStartMs + i * bucketMs;
      return new Date(bucketStart + rand() * bucketMs).toISOString();
    })();
    db.prepare("UPDATE run_profile_tracks SET next_step_at = ? WHERE id = ?").run(slot, row.id);
    const tgt = db.prepare("SELECT full_name, linkedin_url FROM targets WHERE id = (SELECT target_id FROM run_profiles WHERE id = ?)").get(row.run_profile_id) as { full_name: string | null; linkedin_url: string } | undefined;
    log(db, runId, null, "info", `[${track}] Scheduled ${tgt?.full_name ?? tgt?.linkedin_url ?? row.run_profile_id} within active window`);
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

export function startRun(runId: string): void {
  const db = getDb();
  db.prepare("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, datetime('now')) WHERE id = ?").run(runId);
  console.log(`[runner] Run ${runId} marked running — global loop will pick it up`);
}
