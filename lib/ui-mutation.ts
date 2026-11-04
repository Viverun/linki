/**
 * PR-15 (C3): the single mutation boundary for the UI.
 *
 * A UI mutation could fail in three ways and only one of them produced a
 * message:
 *
 *  1. **Transport failure** — `fetch` rejects (offline, DNS, proxy, tab
 *     suspended). No `res` exists at all, so every `if (!res.ok)` guard is
 *     skipped and the handler's promise rejects: no toast, and any optimistic
 *     state change before the call stays applied.
 *  2. **Non-JSON failure body** — a 5xx from Next or a proxy is an HTML error
 *     page. `await res.json()` throws *inside* the error branch, so the handler
 *     dies before it can show the message it was about to show.
 *  3. **Refused mutation with no client check** — discarded `res`, success
 *     toast, row removed locally. The original PR-15 finding.
 *
 * `mutateFetch` closes (1) by never rejecting, `readError` closes (2) by never
 * throwing, and the structural test in `tests/ui-mutation-surface.test.ts`
 * closes (3) by requiring every mutation call site to go through this module.
 *
 * Deliberately NOT a generic `request()` wrapper: it does not parse the body or
 * retry the request. Callers keep their own success path, because several
 * mutate-then-navigate flows are only correct if the navigation is explicit.
 *
 * It does now *classify* — `mutationOutcome` separates a refusal the server
 * stated from an outcome nobody observed — and `reconcileMutation` resolves the
 * second by reading the resource back. That is a read, not a retry: a
 * non-idempotent POST replayed because its response was lost is a duplicate,
 * and no amount of care in the client makes that safe.
 */

/** Shown when the request never reached the server. */
export const NETWORK_ERROR_MESSAGE =
  "Could not reach the server. Check your connection and try again.";

/**
 * Synthetic response for a transport failure.
 *
 * A real `Response` cannot be constructed with `status: 0` (the constructor
 * rejects it), and inventing 5xx would make a network failure indistinguishable
 * from a genuine server error. `status: 0` with `ok: false` is the shape
 * browsers already use for a failed request.
 */
function networkFailure(): Response {
  return {
    ok: false,
    status: 0,
    statusText: "Network Error",
    headers: new Headers({ "Content-Type": "application/json" }),
    json: async () => ({ error: NETWORK_ERROR_MESSAGE }),
    text: async () => NETWORK_ERROR_MESSAGE,
  } as unknown as Response;
}

/**
 * `fetch` for mutations, which never rejects.
 *
 * Network failure resolves to `ok: false` so existing `if (!res.ok)` branches
 * handle it without any new control flow, and `readError` on it returns
 * `NETWORK_ERROR_MESSAGE`.
 */
export async function mutateFetch(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    return networkFailure();
  }
}

/**
 * What the client can actually know from a mutation's response.
 *
 * PR-15's remaining clause is about the third case: a request whose outcome the
 * client cannot observe. `!res.ok` treats every non-success the same, which is
 * wrong in a specific and harmful direction — a 500 from a handler that
 * committed before it threw, or a lost response to a request the server applied,
 * is reported to the operator as "failed". That is a false negative, and acting
 * on it (trying again) is how a duplicate gets created.
 *
 *   - `applied`  — the server said so.
 *   - `refused`  — 4xx: the server read the request and declined it. Definitive,
 *                  and the only case where "it did not happen" is knowable
 *                  without looking.
 *   - `unknown`  — transport failure (`status: 0`) or 5xx. The mutation may be
 *                  in the database or not. Never re-send; verify instead.
 */
export type MutationOutcome = "applied" | "refused" | "unknown";

export function mutationOutcome(res: Pick<Response, "ok" | "status">): MutationOutcome {
  if (res.ok) return "applied";
  if (res.status >= 400 && res.status < 500) return "refused";
  return "unknown";
}

export type Reconciliation = "applied" | "not-applied" | "unknown";

export interface ReconcileOptions<T> {
  /** Read the authoritative state (a GET of the collection the mutation touches). */
  read: () => Promise<T>;
  /** Did the mutation land, judged from that state? */
  confirm: (snapshot: T) => boolean;
  /** Bounded: 4 reads ≈ 2.3s after a lost response, which is enough for a
   *  request already in flight to commit. A mutation that never resolves is a
   *  different problem, and hanging the UI on it is not the fix. */
  attempts?: number;
  delayMs?: number;
}

export interface ReconcileResult<T> {
  state: Reconciliation;
  /** The last state read, so the caller can render server truth either way. */
  snapshot: T | null;
  reads: number;
}

/**
 * Resolve an ambiguous mutation by READING, never by repeating it.
 *
 * The distinction this preserves is the one that matters to an operator:
 *
 *   - `not-applied` — we looked, and it is not there. Safe to try again.
 *   - `unknown`     — we could not look. Saying "failed" would be a guess, so
 *                     the caller must say so and ask for a reload.
 *
 * `attempts > 1` exists because a lost response does not mean the request is
 * finished: the server may still be writing. Retrying the read is safe for any
 * mutation; retrying the mutation is not, which is why there is no such option
 * here.
 */
export async function reconcileMutation<T>(opts: ReconcileOptions<T>): Promise<ReconcileResult<T>> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const delayMs = Math.max(0, opts.delayMs ?? 750);

  let reads = 0;
  let snapshot: T | null = null;
  let lastReadFailed = false;

  for (let i = 0; i < attempts; i++) {
    if (i > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    reads++;
    try {
      const next = await opts.read();
      snapshot = next;
      lastReadFailed = false;
      if (opts.confirm(next)) return { state: "applied", snapshot: next, reads };
    } catch {
      lastReadFailed = true;
    }
  }

  // A read failure at the last attempt means we cannot vouch for absence — the
  // difference between "not there" and "could not see" is the whole point.
  return { state: lastReadFailed ? "unknown" : "not-applied", snapshot, reads };
}

/**
 * The server's `{ error }` message, or `null` when there isn't a usable one
 * (HTML body, empty body, no `error` field, body already read).
 *
 * Never throws — that is the point. Callers supply their own fallback so a
 * refusal is never silent:
 *
 * ```ts
 * if (!res.ok) {
 *   toast.error((await readError(res)) ?? "Could not save this campaign");
 *   return;
 * }
 * ```
 */
export async function readError(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    const message = body?.error;
    return typeof message === "string" && message.trim() !== "" ? message : null;
  } catch {
    return null;
  }
}
