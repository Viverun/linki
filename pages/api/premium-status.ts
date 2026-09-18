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
  // C2-B2: open-core limits are stated, not implied. LinkedIn reply detection
  // lives in ee/; email replies are classified by ee/ when present, else by the
  // open-core policy (lib/email/reply-policy.ts).
  res.status(200).json({
    hasPremium,
    capabilities: {
      linkedinReplyDetection: hasPremium,
      emailReplyClassification: hasPremium ? "premium" : "open-core",
    },
  });
}
