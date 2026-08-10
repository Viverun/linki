/**
 * Helpers for tests that assert on SOURCE TEXT.
 *
 * Not a `.test.ts` file, so the runner's glob ignores it.
 *
 * ── why this exists ──────────────────────────────────────────────────────────
 *
 * A test that greps source is measuring the file, not the behaviour. That is
 * sometimes the only durable guard available — you cannot easily execute "the
 * Dockerfile calls the shared predicate" — but it fails in a specific and quiet
 * way: **the code's own explanatory comments satisfy the assertion.**
 *
 * This is not hypothetical. Five source assertions were audited and four were
 * passing against comments:
 *
 *   A1  watchdog.sh could stop invoking scripts/health-predicate.js entirely;
 *       the header comment naming the file kept the test green.
 *   A2  the Dockerfile's CMD could be replaced with an inline curl; leaving
 *       `# was: CMD node scripts/health-predicate.js` behind kept it green.
 *   A3  HEALTH_SCHEMA could drift 1 -> 2 while a `// legacy: ... = 1` comment
 *       above it fed the old number to `.match()`, which returns the FIRST hit.
 *       The predicate and the route would have silently disagreed about the
 *       contract version — the exact drift that assertion exists to prevent.
 *   A4  the D7 ordering bug could be reinstated, with a comment mentioning
 *       `initialiseConnection(fresh)` supplying the token the ordering check
 *       reads via indexOf.
 *
 * Each was found by the MB9 template: mutate so the TEXT is still satisfied but
 * the BEHAVIOUR is broken, and see whether the test notices.
 *
 * ── the rule ─────────────────────────────────────────────────────────────────
 *
 * Strip comments ALWAYS. Strip string literals when the assertion is about
 * structure. Keep strings only when the emitted text IS the behaviour under
 * test — a shell script's `echo "BUDGET EXHAUSTED"` is a real user-visible
 * output, not incidental prose — and say so at the call site.
 */

/** Comment style: C-like (`//`, `/* *\/`) or hash (`#`), for shell and Dockerfiles. */
export type CommentStyle = "c" | "hash";

/**
 * Removes comments, replacing each with a space so tokens on either side cannot
 * be accidentally fused into a new one.
 *
 * The C-like `//` pattern requires the preceding character not to be `:` so that
 * `https://…` inside code is not mistaken for a line comment.
 */
export function stripComments(src: string, style: CommentStyle = "c"): string {
  if (style === "hash") {
    // Leading-hash or whitespace-preceded hash only: `${x#pattern}` and `$#` are
    // shell parameter expansions, not comments.
    return src.replace(/(^|\s)#.*$/gm, "$1 ");
  }
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

/**
 * Blanks the CONTENTS of string literals, keeping the quotes so the surrounding
 * syntax still parses to the eye. `foo("bar")` becomes `foo("")`.
 *
 * Use when the assertion is about code structure. A doc-comment example, a
 * commented-out line, or an error message quoting the very construct under test
 * would otherwise satisfy it.
 */
export function stripStrings(src: string): string {
  return src.replace(/(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g, (m) => m[0] + m[0]);
}

/**
 * The usual combination: what the file actually DOES, with prose removed.
 *
 * `strings: false` keeps literal contents — pass it when the emitted text is the
 * behaviour, and justify it where you call it.
 */
export function codeOnly(
  src: string,
  opts: { style?: CommentStyle; strings?: boolean } = {}
): string {
  const { style = "c", strings = true } = opts;
  const withoutComments = stripComments(src, style);
  return strings ? stripStrings(withoutComments) : withoutComments;
}
