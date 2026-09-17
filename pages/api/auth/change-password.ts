import type { NextApiRequest, NextApiResponse } from "next";
import { getToken } from "next-auth/jwt";
import { getSessionUser } from "@/lib/auth";
import { compare, hash } from "bcryptjs";
import { getDb } from "@/lib/db";
import { methodNotAllowed } from "@/lib/api-validate";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET }).catch(() => null);
  const sessionUser = getSessionUser(token);
  if (!sessionUser) return res.status(401).json({ error: "Not authenticated" });

  const { currentPassword, newPassword } = req.body as {
    currentPassword?: string;
    newPassword?: string;
  };

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current and new password are required." });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }

  const db = getDb();
  const user = db
    .prepare("SELECT id, password_hash FROM users WHERE id = ? AND session_version = ?")
    .get(sessionUser.id, sessionUser.session_version) as { id: string; password_hash: string } | undefined;

  if (!user) return res.status(401).json({ error: "Not authenticated" });

  const valid = await compare(currentPassword, user.password_hash);
  if (!valid) return res.status(400).json({ error: "Current password is incorrect." });

  const passwordHash = await hash(newPassword, 10);
  const result = db.prepare(
    "UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ? AND session_version = ? AND password_hash = ?"
  ).run(passwordHash, user.id, sessionUser.session_version, user.password_hash);
  if (result.changes !== 1) return res.status(401).json({ error: "Not authenticated" });

  return res.status(200).json({ ok: true });
}
