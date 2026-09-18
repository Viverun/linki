import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { DEFAULT_REPLY_OOO_THRESHOLD, getReplyOooThreshold, setReplyOooThreshold } from "@/lib/email/reply-settings";

/** GET → { ooo_threshold, default }, PUT { ooo_threshold } → set the open-core out-of-office threshold. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  if (req.method === "GET") {
    return res.json({ ooo_threshold: getReplyOooThreshold(db), default: DEFAULT_REPLY_OOO_THRESHOLD });
  }
  if (req.method === "PUT") {
    const n = Number((req.body as { ooo_threshold?: unknown })?.ooo_threshold);
    try {
      setReplyOooThreshold(db, n);
    } catch (err) {
      if (err instanceof RangeError) return res.status(400).json({ error: err.message });
      throw err;
    }
    return res.json({ ooo_threshold: getReplyOooThreshold(db) });
  }
  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end();
}
