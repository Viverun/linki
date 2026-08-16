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
 * Scans C-like source and removes comments WITHOUT being fooled by strings.
 *
 * The regex version — `src.replace(/\/\*[\s\S]*?\*\//g, " ")` — silently
 * corrupted any file containing a `/*` sequence inside a string literal. The
 * live example is `lib/linkedin/session.ts:399`:
 *
 *     await page.waitForURL("**\/feed/**", { timeout: 180_000 });
 *
 * The `/*` inside that string opens a phantom block comment, and everything up
 * to the next real `*\/` — hundreds of lines — is deleted. Quote balance goes
 * with it, so `stripStrings` then mispairs across the rest of the file.
 *
 * The failure is SILENT in the dangerous direction. A positive assertion
 * (`assert.match`) fails loudly when its target is eaten. A negative one
 * (`assert.doesNotMatch`, `assert.ok(!...)`) passes vacuously against a region
 * that no longer exists — which is exactly the shape of assertion these helpers
 * were introduced to make trustworthy.
 *
 * So this walks the source instead. Strings, template literals and comments are
 * tracked as states. Regex literals are not fully parsed — distinguishing them
 * from division needs a real tokenizer — but a `/` immediately followed by `*`
 * cannot occur inside one without an escape, so the practical hazard is closed.
 */
/**
 * Does the `/` at `i` open a REGEX LITERAL rather than a division?
 *
 * H2 (2026-08-16). The walker's first version skipped this, reasoning that "a
 * `/*` or `//` inside a regex cannot occur without an escape, so the practical
 * hazard is closed". The hazard is not `/*` inside a regex — it is a **quote**
 * inside one. `lib/linkedin/scraper.ts:162` and `profile-scrape.ts:177` both
 * contain
 *
 *     .replace(/"/g, "")
 *
 * The walker saw `/`, found neither `/` nor `*` after it, emitted it as an
 * ordinary character, then met `"` and opened a phantom STRING. From there every
 * quote in the file is mispaired and real comments survive as "string contents" —
 * the mirror image of the regex version's `/*`-inside-a-string bug, in the same
 * helper, introduced by the fix for it.
 *
 * Regex-vs-division cannot be settled without a tokenizer, but it can be settled
 * well enough: a `/` begins a regex only where a VALUE may begin, i.e. after an
 * operator, an opening bracket, a comma, a semicolon, or nothing at all. After an
 * identifier, a literal, or a closing bracket it is division.
 */
function opensRegex(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const p = src[j];
  if ("([{,;:=!&|?+-*%<>~^".includes(p)) return true;
  // `return /re/`, `typeof /re/`, `case /re/` — a keyword, not an identifier.
  const word = /[A-Za-z_$][\w$]*$/.exec(src.slice(0, j + 1))?.[0];
  return word ? ["return", "typeof", "case", "in", "of", "delete", "void", "instanceof", "new", "do", "else", "yield", "await"].includes(word) : false;
}

function stripCComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // ── a regex literal: copy verbatim so its quotes cannot open a string ──
    if (c === "/" && next !== "/" && next !== "*" && opensRegex(src, i)) {
      const start = i;
      out += c; i++;
      let inClass = false;
      while (i < src.length) {
        const d = src[i];
        if (d === "\\") { out += d + (src[i + 1] ?? ""); i += 2; continue; }
        if (d === "\n") break;                       // unterminated — not a regex after all
        out += d; i++;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;       // closing delimiter
      }
      // A newline before the delimiter means this was division, not a regex.
      // Rewind and let the ordinary path handle it, so `a / b` is untouched.
      if (src[i - 1] !== "/" || i === start + 1) { out = out.slice(0, out.length - (i - start)); i = start; }
      else continue;
    }

    // ── inside a string or template: copy verbatim, honouring escapes ──
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c; i++;
      while (i < src.length) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += " ";
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }

    out += c; i++;
  }
  return out;
}

/**
 * Removes comments, replacing each with a space so tokens on either side cannot
 * be accidentally fused into a new one.
 *
 * The C-like case walks the source (see `stripCComments`) rather than pattern-
 * matching, so a `//` inside a string — a URL, a glob — is left alone without
 * needing the old `[^:]` lookbehind hack.
 */
export function stripComments(src: string, style: CommentStyle = "c"): string {
  if (style === "hash") {
    // Leading-hash or whitespace-preceded hash only: `${x#pattern}` and `$#` are
    // shell parameter expansions, not comments.
    return src.replace(/(^|\s)#.*$/gm, "$1 ");
  }
  return stripCComments(src);
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
