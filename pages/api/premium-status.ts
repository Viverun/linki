// GET /api/premium-status — open-core endpoint the UI uses to decide whether to render
// premium features or an "Upgrade to Premium" affordance. Returns { hasPremium } which is
// true in the commercial build (ee/ present) and false in the public open-source build.
import type { NextApiRequest, NextApiResponse } from "next";
import { hasPremium } from "@/lib/premium";
import { methodNotAllowed } from "@/lib/api-validate";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // Phase 2: all UI callers use GET; an unguarded ALL-methods route is a
  // contract accident.
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  res.status(200).json({ hasPremium });
}
