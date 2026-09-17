import nodemailer from "nodemailer";
import Imap from "imap";
import { emailTlsOptions } from "@/lib/email/tls";

export interface EmailAccount {
  id: string;
  from_email: string;
  from_name: string | null;
  reply_to?: string | null;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number; // 0 = STARTTLS, 1 = SSL
  username: string;
  password: string;
}

export interface SendResult {
  /** Recipients the SMTP server accepted (transport acceptance, not delivery). */
  accepted: string[];
  rejected: string[];
  messageId: string | null;
}

export async function sendEmail(
  account: EmailAccount,
  to: string,
  subject: string,
  body: string
): Promise<SendResult> {
  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: account.smtp_secure === 1,
    auth: {
      user: account.username,
      pass: account.password,
    },
    requireTLS: true,
    tls: emailTlsOptions(account.smtp_host),
  });

  const from = account.from_name
    ? `"${account.from_name}" <${account.from_email}>`
    : account.from_email;

  const info = await transporter.sendMail({
    from, to, subject, text: body,
    ...(account.reply_to ? { replyTo: account.reply_to } : {}),
  });
  const addr = (v: unknown) => (typeof v === "string" ? v : (v as { address?: string })?.address ?? String(v));
  return {
    accepted: (info.accepted ?? []).map(addr),
    rejected: (info.rejected ?? []).map(addr),
    messageId: info.messageId ?? null,
  };
}

export type SmtpFailureClass = "pre_send" | "rejected" | "ambiguous";

/** SMTP commands that provably precede the message body. */
const PRE_DATA_COMMANDS = new Set(["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL FROM", "RCPT TO", "API"]);
/** Node TLS error codes raised by our own verification policy, before any SMTP command. */
const TLS_POLICY_CODES = /^(ERR_TLS_|CERT_|DEPTH_ZERO_|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH)/;
/** Socket errors that may indicate closure after transmission. */
const SOCKET_CLOSE_PATTERNS = /^(Connection closed|connection closed|socket closed|EHOSTUNREACH|ENOTFOUND|ENETRESET)/i;

/**
 * Where did an SMTP send fail, and can the message have been delivered?
 *
 * - pre_send: the failure provably happened before the body was transmitted
 *   (connection, TLS policy, greeting, auth, envelope). Nothing was delivered.
 * - rejected: the server answered the DATA phase with a 4xx/5xx reply. It told
 *   us it did not accept the message.
 * - ambiguous: the socket died at or after DATA with no reply, or the error
 *   carries no recognisable metadata. Delivery cannot be ruled out. This is the
 *   DEFAULT — unknown means possibly delivered.
 */
export function classifySmtpFailure(err: unknown): SmtpFailureClass {
  if (!(err instanceof Error)) return "ambiguous";
  const { code, command, responseCode, message } = err as Error & { code?: string; command?: string; responseCode?: number; message?: string };
  if (typeof code === "string" && TLS_POLICY_CODES.test(code)) return "pre_send";
  // Socket errors with "closed" or "reset" in the message likely happened after transmission started
  if (typeof message === "string" && SOCKET_CLOSE_PATTERNS.test(message)) return "ambiguous";
  if (command && PRE_DATA_COMMANDS.has(command)) return "pre_send";
  if (command === "DATA") {
    return typeof responseCode === "number" && responseCode >= 400 ? "rejected" : "ambiguous";
  }
  return "ambiguous";
}

/**
 * Verifies SMTP connectivity — used by the test-connection endpoint.
 * Returns null on success, error message string on failure.
 */
export async function testSmtpConnection(account: Omit<EmailAccount, "id">): Promise<string | null> {
  try {
    const transporter = nodemailer.createTransport({
      host: account.smtp_host,
      port: account.smtp_port,
      secure: account.smtp_secure === 1,
      auth: { user: account.username, pass: account.password },
      requireTLS: true,
      tls: emailTlsOptions(account.smtp_host),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    });
    await transporter.verify();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export interface ImapTestAccount {
  imap_host: string;
  imap_port: number;
  username: string;
  password: string;
  imap_username: string | null;
  imap_password: string | null;
}

/**
 * Verifies IMAP connectivity — connects, authenticates, then disconnects.
 * Returns null on success, error message string on failure.
 */
export async function testImapConnection(account: ImapTestAccount): Promise<string | null> {
  return new Promise((resolve) => {
    const imap = new Imap({
      host: account.imap_host,
      port: account.imap_port,
      tls: true,
      tlsOptions: emailTlsOptions(account.imap_host),
      user: account.imap_username ?? account.username,
      password: account.imap_password ?? account.password,
      authTimeout: 10_000,
      connTimeout: 12_000,
    });

    imap.once("ready", () => {
      try { imap.end(); } catch { /* ignore */ }
      resolve(null);
    });

    imap.once("error", (err: Error) => {
      resolve(err.message ?? String(err));
    });

    imap.connect();
  });
}
