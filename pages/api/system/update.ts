import type { NextApiRequest, NextApiResponse } from "next";
import { getUpdateState } from "@/lib/update-check";
import { methodNotAllowed } from "@/lib/api-validate";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // Phase 2: the only caller (Sidebar) uses GET; an unguarded ALL-methods
  // route is a contract accident.
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  res.json(getUpdateState());
}
