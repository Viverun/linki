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
 * Deliberately NOT a generic `request()` wrapper: it does not parse, retry or
 * interpret success. Callers keep their own success path, because several
 * mutate-then-navigate flows are only correct if the navigation is explicit.
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
