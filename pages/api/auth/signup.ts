import type { NextApiRequest, NextApiResponse } from "next";
import bcrypt from "bcryptjs";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { isRateLimited } from "@/lib/rate-limit";
import { methodNotAllowed } from "@/lib/api-validate";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  // Invite code + password are both guessable secrets — throttle attempts per IP.
  if (isRateLimited(req, "signup", 10, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }

  // F4: Linki is single-tenant. Once this instance has an owner, registration
  // closes permanently.
  //
  // The invite code IS `AUTH_PASSWORD` — the same secret used to log in — so
  // while this route stayed open, anyone who learned the login password could
  // also mint additional accounts, and every account has full access to the
  // stored LinkedIn sessions, message bodies and target lists. "They already
  // need the password" is not a defence: a password authenticates the owner, it
  // does not authorise creating new owners, and a second account is far quieter
  // than a login because nothing in the UI surfaces one.
  //
  // Checked FIRST, before the body is validated or bcrypt is reached: a closed
  // route that still hashes is a free CPU-exhaustion primitive (bcrypt cost 10 is
  // ~100ms), and the rate limiter allows 10 attempts before it engages.
  const db = getDb();
  const owners = (db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c;
  if (owners > 0) {
    // Says "closed", not "invalid invite code". An operator who mistyped nothing
    // should not be sent hunting for a wrong secret.
    return res.status(403).json({ error: "Registration is closed — this instance already has an account." });
  }

  const { email, password, inviteCode } = req.body as {
    email?: string;
    password?: string;
    inviteCode?: string;
  };

  if (!email || !password || !inviteCode) {
    return res.status(400).json({ error: "Email, password, and invite code are required." });
  }

  const authPassword = process.env.AUTH_PASSWORD;
  if (!authPassword) {
    return res.status(500).json({ error: "AUTH_PASSWORD is not configured on this server." });
  }

  if (inviteCode !== authPassword) {
    return res.status(403).json({ error: "Invalid invite code." });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const hash = await bcrypt.hash(password, 10);
  db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)").run(randomUUID(), email, hash);

  return res.status(201).json({ ok: true });
}
