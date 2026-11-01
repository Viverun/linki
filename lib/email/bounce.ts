import type { getDb } from "@/lib/db";

/**
 * PR-14 (C3): bounce scope.
 *
 * The IMAP scan used to take every address found in a bounce body — the
 * original sender, our own from-address, unrelated quoted headers, the
 * recipient — and invalidate the first one that happened to match a target.
 * It then skipped *all* of that contact's tracks (LinkedIn included) and marked
 * every colleague at the same company invalid, because the domain was flagged.
 *
 * The blast radius is now decided by evidence rather than by a regex sweep:
 *
 * - **Nothing at all** for a temporary failure (`4.x.x`, `Action: delayed`,
 *   mailbox full, greylisting). A retried delivery is not a dead address.
 * - **The correlated recipient only** for a permanent recipient failure
 *   (`5.1.1` user unknown, `5.2.2` mailbox full). One person's mailbox says
 *   nothing about a colleague's, and nothing about their LinkedIn outreach.
 * - **The recipient and the company domain** only for a permanent *domain*
 *   failure (`5.1.2` bad destination system, `5.4.4` no route, `5.1.10` null
 *   MX) — that is the "stronger evidence" that justifies touching the company
 *   at all. Even then, siblings are not invalidated: the flag is checked when
 *   their email track is about to send, so a re-verified address still works.
 *
 * Anything ambiguous — no `Final-Recipient`, or several target addresses and no
 * way to tell which one bounced — is deliberately left alone and reported, so
 * the worst case is a bounce that needs a human, not a contact wrongly deleted
 * from every campaign.
 */

type Db = ReturnType<typeof getDb>;

export type BounceKind = "temporary" | "recipient" | "domain" | "unknown";

export interface ParsedBounce {
  /** The address the DSN ultimately failed for, when the DSN says so. */
  recipient: string | null;
  kind: BounceKind;
  /** The SMTP status that decided `kind`, for the log line and for tests. */
  status: string | null;
}

const BOUNCE_SENDER_PATTERNS = [
  /mailer-daemon@/i,
  /postmaster@/i,
  /mail-delivery-subsystem@/i,
  /delivery-status@/i,
  /amazonses\.com$/i,
];

/** Permanent failures that describe the *host/domain*, not one mailbox. */
const DOMAIN_LEVEL = [/^5\.1\.2/, /^5\.4\.4/, /^5\.1\.10/, /^5\.7\.1/];

export function isBounceSender(fromEmail: string): boolean {
  return BOUNCE_SENDER_PATTERNS.some((p) => p.test(fromEmail));
}

function extractEmails(text: string): string[] {
  return [
    ...text.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g),
  ].map((m) => m[0].toLowerCase());
}

function header(body: string, field: string): string | null {
  // The address sits after `rfc822;`, but some MTAs emit a bare address.
  const m = body.match(new RegExp(`^${field}:\\s*(?:rfc822;\\s*)?<?([^\\s>]+@[^\\s>]+)>?`, "im"));
  return m?.[1]?.toLowerCase().trim() ?? null;
}

/**
 * Classify a delivery-status notification.
 *
 * `Status:` is authoritative (RFC 3463). `Action: delayed` is used when a
 * provider omits it. A DSN with neither is `unknown`, not `recipient` — guessing
 * is how the old code invalidated contacts.
 */
export function parseBounce(body: string): ParsedBounce {
  const statuses = [...body.matchAll(/^Status:\s*(\d\.\d+\.\d+)/gim)].map((m) => m[1]);
  const recipient = header(body, "Final-Recipient") ?? header(body, "Original-Recipient");

  const permanent = statuses.find((s) => s.startsWith("5."));
  if (permanent) {
    const domainWide = DOMAIN_LEVEL.some((p) => p.test(permanent));
    return { recipient, kind: domainWide ? "domain" : "recipient", status: permanent };
  }

  const temporary = statuses.find((s) => s.startsWith("4."));
  if (temporary) return { recipient, kind: "temporary", status: temporary };

  if (/^Action:\s*delayed/im.test(body)) return { recipient, kind: "temporary", status: null };

  return { recipient, kind: "unknown", status: null };
}

export interface BounceOutcome {
  applied: boolean;
  /** Why nothing (or something) happened — goes straight to the sync log. */
  reason: string;
  recipient: string | null;
  kind: BounceKind;
  /** True when the company domain flag was set as well. */
  companyFlagged: boolean;
}

/**
 * Apply one bounce report. Idempotent: re-processing the same DSN changes
 * nothing and does not duplicate the note.
 */
export function applyBounce(
  db: Db,
  opts: { body: string; toRaw?: string; fromEmail?: string }
): BounceOutcome {
  const parsed = parseBounce(opts.body);
  const outcome: BounceOutcome = {
    applied: false,
    reason: "",
    recipient: parsed.recipient,
    kind: parsed.kind,
    companyFlagged: false,
  };

  if (parsed.kind === "temporary") {
    outcome.reason = `temporary failure${parsed.status ? ` (${parsed.status})` : ""} — address kept`;
    return outcome;
  }
  if (parsed.kind === "unknown") {
    // A DSN we cannot classify is not evidence. Silence here is the safe
    // direction: the address stays, and the raw message is still in the mailbox.
    outcome.reason = "delivery report without a usable status — ignored";
    return outcome;
  }

  // Our own addresses are the sender of the original mail and therefore common
  // in a DSN body; they are never the bounced recipient.
  const ownAddresses = new Set(
    (db.prepare("SELECT lower(from_email) AS a FROM email_accounts").all() as { a: string }[])
      .map((r) => r.a)
      .concat(opts.fromEmail ? [opts.fromEmail.toLowerCase()] : [])
  );

  let recipient = parsed.recipient;
  if (!recipient) {
    const matches = extractEmails(`${opts.body} ${opts.toRaw ?? ""}`)
      .filter((a) => !ownAddresses.has(a) && !isBounceSender(a))
      .filter((a) =>
        db.prepare("SELECT 1 FROM targets WHERE lower(email) = ? AND (email_status IS NULL OR email_status != 'invalid')").get(a)
      );
    const unique = [...new Set(matches)];
    // Exactly one correlation is evidence; two is a coin flip.
    if (unique.length !== 1) {
      outcome.reason = unique.length === 0
        ? "no recipient in the report matched a contact — ignored"
        : `${unique.length} candidate recipients and no Final-Recipient — ignored to avoid invalidating the wrong contact`;
      return outcome;
    }
    recipient = unique[0];
    outcome.recipient = recipient;
  }

  if (BOUNCE_SENDER_PATTERNS.some((p) => p.test(recipient!)) || ownAddresses.has(recipient)) {
    outcome.reason = "report names our own or a bounce address — ignored";
    return outcome;
  }

  const target = db
    .prepare("SELECT id, email_status, company_id FROM targets WHERE lower(email) = ?")
    .get(recipient) as { id: string; email_status: string | null; company_id: string | null } | undefined;

  if (!target) {
    outcome.reason = "no contact uses that address — nothing to do";
    return outcome;
  }
  if (target.email_status === "invalid") {
    outcome.reason = "contact was already marked invalid — no change";
    return outcome;
  }

  const day = new Date().toISOString().slice(0, 10);
  const note = `Email bounced on ${day} — marked invalid`;

  db.transaction(() => {
    db.prepare(`
      UPDATE targets SET email_status = 'invalid',
        notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || char(10) || ? END
      WHERE id = ?
    `).run(note, note, target.id);

    // Email track only: a dead mailbox says nothing about the LinkedIn thread,
    // so that track keeps running.
    db.prepare(`
      UPDATE run_profile_tracks SET state = 'skipped', error_message = 'Email bounced — invalid address'
      WHERE track = 'email'
        AND state IN ('pending', 'in_progress')
        AND run_profile_id IN (SELECT id FROM run_profiles WHERE target_id = ?)
    `).run(target.id);

    if (parsed.kind === "domain" && target.company_id) {
      const companyNote = `Email domain flagged on ${day} — ${parsed.status ?? "permanent domain failure"} for ${recipient}`;
      // Only the first domain-level failure annotates the company; later ones
      // for the same domain add nothing and would duplicate the note.
      const flagged = db
        .prepare("SELECT email_domain_invalid FROM companies WHERE id = ?")
        .get(target.company_id) as { email_domain_invalid: number | null } | undefined;
      if (flagged && !flagged.email_domain_invalid) {
        db.prepare(`
          UPDATE companies SET email_domain_invalid = 1,
            notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || char(10) || ? END
          WHERE id = ?
        `).run(companyNote, companyNote, target.company_id);
        outcome.companyFlagged = true;
      }
    }
  })();

  outcome.applied = true;
  outcome.reason = `marked ${recipient} invalid${outcome.companyFlagged ? " and flagged the company domain" : ""}`;
  return outcome;
}
