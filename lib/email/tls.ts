/**
 * Phase 3.3: the ONE place that decides email TLS verification.
 *
 * `false` (verify off) is deliberate, not drift: operators connect to
 * corporate SMTP/IMAP servers with self-signed certificates, and refusing
 * them would break working deployments with no user ask. The cost is
 * MITM-ability on those connections, so this stays a single named constant
 * with the tradeoff attached — flip it here, not in six call sites, if the
 * default ever changes.
 */
export const EMAIL_TLS_REJECT_UNAUTHORIZED = false;

export function emailTlsOptions(): { rejectUnauthorized: boolean } {
  return { rejectUnauthorized: EMAIL_TLS_REJECT_UNAUTHORIZED };
}
