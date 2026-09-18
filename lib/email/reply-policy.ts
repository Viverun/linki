import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { TypeSafeClient, noul, choice, type EntryType } from "@typesafe-ai/sdk";
import { decryptSecret } from "@/lib/crypto";
import { getReplyOooThreshold } from "@/lib/email/reply-settings";

/**
 * Open-core reply policy (C2-B2 / PR-03).
 *
 * Premium (ee/) classifies and dispatches replies itself. Without it, nothing
 * decided what a captured reply meant, so the runner kept sending follow-ups to
 * people who had answered. This module makes exactly one decision per reply:
 *   - an automatic out-of-office notice (high probability) keeps the enrolment,
 *     optionally pushing the next email past the stated return date;
 *   - anything else is a person answering → targets.email_replied_at, which the
 *     runner turns into the usual "Lead replied" skip.
 * It never sends. Judgment failures leave the reply undecided (the runner holds
 * on that) and are retried; three failures fail closed. An operator can decide a
 * reply (e.g. mark it handled) at any time, including while a judgment call is
 * in flight — every write here is guarded so that race can only ever lose, never
 * overwrite the operator's decision.
 */

export interface ReplyState {
  reply: { from: string; subject: string; body: string; received_at: string };
  our_last_email: { subject: string; body: string } | null;
  today: string;
}
export interface ReplyJudgment {
  pOoo: number;
  model: string;
  returnDate: { chosen: string | null; confidence: number } | null;
}
export type Judge = (state: ReplyState, dateCandidates: string[]) => Promise<ReplyJudgment>;
export type ReplyDecision = "ooo_continue" | "human_reply" | "operator_continue";

const MAX_ATTEMPTS = 3;
const RETURN_DATE_MIN_CONFIDENCE = 0.7;
const BODY_LIMIT = 4000;
const MAX_CANDIDATES = 8;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STALE_YEARLESS_DAYS = 60; // a past year-less date within this window is stale, not "next year"
const RETURN_DATE_HORIZON_DAYS = 180; // a return date further out than this is treated as unstated

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/g,                                                      // 2026-10-04
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?(?:,?\\s+\\d{4})?\\b`, "gi"), // 2 October 2026, 2nd Oct
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "gi"), // October 3rd, 2026
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,                                               // 05/10/2026
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi, // Monday 6th
];

/** Date-like spans in the order they appear, de-duplicated, at most MAX_CANDIDATES. */
export function extractDateCandidates(body: string): string[] {
  const found: string[] = [];
  for (const re of DATE_PATTERNS) {
    for (const m of body.matchAll(re)) {
      const span = m[0].trim();
      if (!found.includes(span)) found.push(span);
    }
  }
  return found.slice(0, MAX_CANDIDATES);
}

const MONTH_INDEX: Record<string, number> = Object.fromEntries(
  MONTHS.split("|").map(m => [m, ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(m.slice(0, 3))])
);
function utcDate(y: number, m: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt : null;
}
/**
 * The chosen span as a UTC midnight date, or null when it is not a real date.
 * Year-less dates resolve relative to today: a this-year occurrence that has already
 * passed by STALE_YEARLESS_DAYS or less is stale (null, not rolled) — "back 15 September"
 * read on 18 September almost certainly means the September that just happened, not next
 * year's. Only a this-year occurrence more than STALE_YEARLESS_DAYS in the past rolls to
 * next year (e.g. "back 5 January" read in November).
 */
export function parseReturnDate(span: string, today: Date): Date | null {
  const s = span.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)/g, "$1").replace(/\./g, "");
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return utcDate(+m[1], +m[2] - 1, +m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) { // day/month/year (the app's users write European order)
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return utcDate(y, +m[2] - 1, +m[1]);
  }
  let day: number | undefined, month: number | undefined, year: number | undefined;
  if ((m = s.match(new RegExp(`^(\\d{1,2})\\s+(${MONTHS})(?:,?\\s+(\\d{4}))?$`)))) { day = +m[1]; month = MONTH_INDEX[m[2]]; year = m[3] ? +m[3] : undefined; }
  else if ((m = s.match(new RegExp(`^(${MONTHS})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?$`)))) { month = MONTH_INDEX[m[1]]; day = +m[2]; year = m[3] ? +m[3] : undefined; }
  else return null; // weekday-only forms ("Monday 6th") are too ambiguous to act on
  if (day === undefined || month === undefined) return null;
  if (year !== undefined) return utcDate(year, month, day);
  const todayMidnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const thisYear = utcDate(today.getUTCFullYear(), month, day);
  if (!thisYear) return utcDate(today.getUTCFullYear() + 1, month, day); // e.g. 29 Feb in a non-leap year
  if (thisYear.getTime() >= todayMidnight) return thisYear;
  const pastDays = (todayMidnight - thisYear.getTime()) / MS_PER_DAY;
  if (pastDays <= STALE_YEARLESS_DAYS) return null; // too recent to plausibly mean "next year"
  return utcDate(today.getUTCFullYear() + 1, month, day);
}

/** The production judge: one fan-out request to Jev. */
export function jevJudge(apiKey: string): Judge {
  return async (state, dateCandidates) => {
    const client = new TypeSafeClient({ apiKey, timeout: 10_000 });
    const questions = {
      is_auto_reply: noul(
        "`reply` is an automatic out-of-office or auto-responder notice generated because the recipient is away, not a message a person wrote in response to `our_last_email`.",
        {
          true: "Vacation, leave, out-of-office, 'I am currently away', 'limited access to email', auto-generated acknowledgement with a return date or alternative contact.",
          false: "Anything a person typed as a response — including a one-line 'not interested', 'stop emailing me', a question, a forward to a colleague, or a delivery/bounce notice.",
        }
      ),
      ...(dateCandidates.length > 0 ? {
        return_date: choice(
          "Which candidate is the date the sender says they will be back or resume reading email? Choose `none` if no return date is stated.",
          Object.fromEntries([...dateCandidates.map(c => [c, null]), ["none", null]])
        ),
      } : {}),
    };
    // ReplyState is a plain JSON-shaped object but has no index signature, so it doesn't
    // structurally satisfy EntryType ({ [key: string]: JsonValue }) — cast, not any.
    const response = await client.systemOne({ state: state as unknown as EntryType, questions });
    const answers = response.answers as { is_auto_reply: { noul: number }; return_date?: { choice: string; confidence: number } };
    const rd = answers.return_date;
    return {
      pOoo: answers.is_auto_reply.noul,
      model: response.model,
      returnDate: rd ? { chosen: rd.choice === "none" ? null : rd.choice, confidence: rd.confidence } : null,
    };
  };
}

function defaultJudge(db: Database.Database): Judge {
  return async (state, candidates) => {
    const row = db.prepare("SELECT api_key FROM integrations WHERE key = 'typesafe'").get() as { api_key: string | null } | undefined;
    const key = row?.api_key ? decryptSecret(row.api_key) : null;
    if (!key) throw new Error("TypeSafe API key is not configured (Settings → Integrations)");
    return jevJudge(key)(state, candidates);
  };
}

interface ReplyRow { id: string; target_id: string; run_id: string | null; from_email: string; subject: string | null; body_text: string; received_at: string; dispatched_at: string | null; dispatch_result_json: string | null; open_core_attempts: number }

function returnAt09(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 9, 0, 0)).toISOString();
}

/** The decision already recorded on a reply (set by us or by an operator), defaulting to operator_continue. */
function priorDecision(db: Database.Database, replyId: string): ReplyDecision {
  const current = db.prepare("SELECT dispatch_result_json FROM email_replies WHERE id = ?").get(replyId) as { dispatch_result_json: string | null } | undefined;
  const prior = current?.dispatch_result_json ? (JSON.parse(current.dispatch_result_json) as { decision?: ReplyDecision }).decision : undefined;
  return prior ?? "operator_continue";
}

/**
 * Atomically claim the next attempt: increments open_core_attempts in SQL (never from a
 * stale in-memory read) and returns the new count, but only if the reply is still undecided.
 * Returns null when an operator (or a previous call) decided the reply in the meantime.
 */
function bumpAttempts(db: Database.Database, replyId: string): number | null {
  const row = db.prepare(
    "UPDATE email_replies SET open_core_attempts = open_core_attempts + 1 WHERE id = ? AND dispatched_at IS NULL RETURNING open_core_attempts"
  ).get(replyId) as { open_core_attempts: number } | undefined;
  return row ? row.open_core_attempts : null;
}

/**
 * Decide one reply. Returns the decision, or "undecided" when the judgment failed
 * and attempts remain. Safe to call again: an already-decided row is a no-op. Safe to
 * race against an operator decision: whichever writer's guarded UPDATE lands first wins,
 * and the loser reports that decision back instead of overwriting it.
 */
export async function decideReplyOpenCore(db: Database.Database, replyId: string, judge: Judge = defaultJudge(db)): Promise<ReplyDecision | "undecided"> {
  const row = db.prepare("SELECT id, target_id, run_id, from_email, subject, body_text, received_at, dispatched_at, dispatch_result_json, open_core_attempts FROM email_replies WHERE id = ?").get(replyId) as ReplyRow | undefined;
  if (!row) throw new Error(`reply ${replyId} not found`);
  if (row.dispatched_at) {
    const prior = row.dispatch_result_json ? (JSON.parse(row.dispatch_result_json) as { decision?: ReplyDecision }).decision : undefined;
    return prior ?? "operator_continue";
  }
  const threshold = getReplyOooThreshold(db);
  const track = row.run_id
    ? db.prepare(`SELECT rt.last_email_subject, rt.last_email_body FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id
                  WHERE rp.run_id = ? AND rp.target_id = ? AND rt.track = 'email'`).get(row.run_id, row.target_id) as { last_email_subject: string | null; last_email_body: string | null } | undefined
    : undefined;
  const today = new Date();
  const state: ReplyState = {
    reply: { from: row.from_email, subject: row.subject ?? "", body: row.body_text.slice(0, BODY_LIMIT), received_at: row.received_at },
    our_last_email: track?.last_email_subject || track?.last_email_body
      ? { subject: (track?.last_email_subject ?? "").slice(0, 500), body: (track?.last_email_body ?? "").slice(0, BODY_LIMIT) }
      : null,
    today: today.toISOString().slice(0, 10),
  };
  const candidates = extractDateCandidates(state.reply.body);

  // Everything from here on is synchronous (no further `await`), so once bumpAttempts
  // observes dispatched_at IS NULL, nothing else in this process can race it before the
  // decision is written — the only race window was the `await judge(...)` above.
  let judgment: ReplyJudgment;
  try {
    judgment = await judge(state, candidates);
    if (!Number.isFinite(judgment.pOoo)) throw new Error(`judge returned a non-finite probability (${judgment.pOoo})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = bumpAttempts(db, row.id);
    if (attempts === null) return priorDecision(db, row.id); // an operator decided while we were judging
    if (attempts >= MAX_ATTEMPTS) {
      return db.transaction(() => recordDecision(db, row, "human_reply", { p_ooo: null, threshold, model: null, return_date: null, attempts, reason: `judgment failed ${MAX_ATTEMPTS} times — failing closed` }, `Reply could not be judged (${message}); follow-ups stopped`)).immediate();
    }
    db.prepare("UPDATE email_replies SET classification_error = ? WHERE id = ? AND dispatched_at IS NULL").run(message.slice(0, 500), row.id);
    return "undecided";
  }

  const attempts = bumpAttempts(db, row.id);
  if (attempts === null) return priorDecision(db, row.id); // an operator decided while we were judging

  const pOoo = Math.max(0, Math.min(1, judgment.pOoo));
  if (pOoo >= threshold) {
    let returnDate: Date | null = null;
    if (judgment.returnDate?.chosen && judgment.returnDate.confidence >= RETURN_DATE_MIN_CONFIDENCE) {
      const parsed = parseReturnDate(judgment.returnDate.chosen, today);
      if (parsed && parsed.getTime() > today.getTime() && parsed.getTime() - today.getTime() <= RETURN_DATE_HORIZON_DAYS * MS_PER_DAY) {
        returnDate = parsed;
      }
    }
    const iso = returnDate ? returnDate.toISOString().slice(0, 10) : null;
    const resumeAt = returnDate ? returnAt09(returnDate) : null;
    return db.transaction(() => {
      const decision = recordDecision(db, row, "ooo_continue", { p_ooo: pOoo, threshold, model: judgment.model, return_date: iso, attempts },
        `Out-of-office reply — follow-up continues after ${resumeAt ? resumeAt.slice(0, 10) : "unchanged schedule"}`,
        { kind: "out_of_office", summary: `Automatic out-of-office reply (p=${pOoo}); ${iso ? `back ${iso}` : "no return date"}` });
      if (decision === "ooo_continue" && resumeAt && row.run_id) {
        db.prepare(`UPDATE run_profile_tracks SET next_step_at = CASE WHEN next_step_at IS NULL OR datetime(next_step_at) < datetime(?) THEN ? ELSE next_step_at END
                    WHERE track = 'email' AND state IN ('pending', 'in_progress')
                      AND run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ? AND target_id = ?)`).run(resumeAt, resumeAt, row.run_id, row.target_id);
      }
      return decision;
    }).immediate();
  }
  return db.transaction(() => recordDecision(db, row, "human_reply", { p_ooo: pOoo, threshold, model: judgment.model, return_date: null, attempts }, "Reply received — follow-ups stopped",
    { kind: "human_reply", summary: `A person replied (p_ooo=${pOoo})` })).immediate();
}

/**
 * Write a decision, guarded against a concurrent decision (operator or otherwise): the UPDATE
 * only takes effect while dispatched_at is still NULL. When it loses that race, no stamp, no
 * activity log, and no schedule change happen — the caller's decision is discarded in favor of
 * whatever was already recorded, which this returns.
 */
function recordDecision(
  db: Database.Database, row: ReplyRow, decision: ReplyDecision,
  result: { p_ooo: number | null; threshold: number; model: string | null; return_date: string | null; attempts: number; reason?: string },
  activity: string,
  classification: { kind: "out_of_office" | "human_reply"; summary: string } = { kind: "human_reply", summary: result.reason ?? "A person replied" }
): ReplyDecision {
  const now = new Date().toISOString();
  const info = db.prepare(`UPDATE email_replies SET dispatched_at = ?, dispatch_result_json = ?, classified_at = ?, classification_json = ?, classification_error = NULL, open_core_attempts = ?
              WHERE id = ? AND dispatched_at IS NULL`)
    .run(now, JSON.stringify({ source: "open-core", decision, ...result }), now, JSON.stringify(classification), result.attempts, row.id);
  if (info.changes === 0) return priorDecision(db, row.id);
  if (decision === "human_reply") {
    db.prepare("UPDATE targets SET email_replied_at = COALESCE(email_replied_at, ?) WHERE id = ?").run(now, row.target_id);
  }
  db.prepare("INSERT INTO activity_logs (id, target_id, type, body) VALUES (?, ?, 'email', ?)").run(randomUUID(), row.target_id, activity);
  return decision;
}

/**
 * Retry every undecided reply (open-core only). Returns how many reached a decision.
 * Bounded to a small batch per call (default 10, was 50) so a sweep run from inside a
 * runner tick or IMAP sync cannot monopolise it.
 */
export async function retryUndecidedReplies(db: Database.Database, judge?: Judge, { limit = 10 }: { limit?: number } = {}): Promise<number> {
  const rows = db.prepare("SELECT id FROM email_replies WHERE dispatched_at IS NULL ORDER BY received_at ASC LIMIT ?").all(limit) as Array<{ id: string }>;
  let decided = 0;
  for (const { id } of rows) {
    const d = await decideReplyOpenCore(db, id, judge);
    if (d !== "undecided") decided++;
  }
  return decided;
}
