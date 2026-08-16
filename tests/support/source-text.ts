import ts from "typescript";
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
 * Removes C-family comments using **TypeScript's own parser**, not a hand-rolled
 * lexer.
 *
 * ── why this is not hand-rolled any more ─────────────────────────────────────
 *
 * Two hand-written implementations failed the same way, each blind to a lexical
 * context it did not model:
 *
 *   1. The regex version treated `/*` INSIDE A STRING as a comment opener —
 *      `"**\/feed/**"` in session.ts ate 1905 chars — and treated `//` inside a
 *      REGEX as a line comment, truncating live authwall guards in
 *      sync-accepted.ts and connect.ts.
 *   2. Its walker replacement inverted the bug: a QUOTE inside a REGEX
 *      (`.replace(/"/g, "")`) opened a phantom string, after which real comments
 *      survived as "string contents" in four more files.
 *
 * A third hand-rolled attempt is not the answer. `typescript` is already a
 * dependency and `tsc` runs on every gate, so the correct tokenizer is already
 * in the tree. It models regex literals, template literals with nested
 * substitutions, JSX, and string escapes by construction — the whole class of
 * defect is gone rather than patched.
 *
 * Comments are TRIVIA in TS's model, so they are read off the parsed tree via
 * `getLeadingCommentRanges` / `getTrailingCommentRanges` and blanked. Parsing
 * resolves regex-vs-division properly, which is the ambiguity both hand-rolled
 * versions got wrong.
 *
 * Parsed as TSX so `.tsx` files work; `tests/source-text-corpus.test.ts` proves
 * on every tracked source file that the token stream is unchanged, which is what
 * would catch the TSX/`<T>`-assertion edge if this repo ever used it.
 */
function stripCCommentsTs(src: string): string {
  const sf = ts.createSourceFile("__source-text__.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const seen = new Set<number>();
  const ranges: ts.CommentRange[] = [];
  const take = (rs: ts.CommentRange[] | undefined) => {
    for (const r of rs ?? []) if (!seen.has(r.pos)) { seen.add(r.pos); ranges.push(r); }
  };
  const visit = (n: ts.Node) => {
    take(ts.getLeadingCommentRanges(src, n.getFullStart()));
    take(ts.getTrailingCommentRanges(src, n.getEnd()));
    n.forEachChild(visit);
  };
  visit(sf);
  ranges.sort((a, b) => a.pos - b.pos);

  let out = "";
  let last = 0;
  for (const r of ranges) {
    if (r.pos < last) continue;            // nested/overlapping: already covered
    out += src.slice(last, r.pos) + " ";   // a space, so tokens cannot fuse
    last = r.end;
  }
  return out + src.slice(last);
}

/**
 * Removes comments, replacing each with a space so tokens on either side cannot
 * be accidentally fused into a new one.
 *
 * The C-like case is delegated to TypeScript's parser (see `stripCCommentsTs`),
 * so a `//` inside a string, a glob or a regex is left alone by construction —
 * no lookbehind hacks, no hand-rolled state machine.
 *
 * The hash case is deliberately a one-line regex: shell has no block-comment
 * form at all, so
 * the entire class of defect that motivated the parser simply does not exist
 * there, and a second parser dependency would be more risk than it removes.
 */
export function stripComments(src: string, style: CommentStyle = "c"): string {
  if (style === "hash") {
    // Leading-hash or whitespace-preceded hash only: `${x#pattern}` and `$#` are
    // shell parameter expansions, not comments.
    return src.replace(/(^|\s)#.*$/gm, "$1 ");
  }
  return stripCCommentsTs(src);
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
  // Parser-backed, for the same reason as stripComments. The regex version
  // mispaired quotes in JSX — an apostrophe in prose or a quote in an attribute
  // desynchronised it and it blanked real code. The Y4 corpus test caught it on
  // three .tsx files, which is what a property test is for.
  const sf = ts.createSourceFile("__source-text__.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const blanks: { pos: number; end: number }[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      // keep both delimiters, blank what is between them
      blanks.push({ pos: n.getStart(sf) + 1, end: n.getEnd() - 1 });
    } else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n)) {
      // `head${  /  }middle${  — two delimiter chars at the tail end
      blanks.push({ pos: n.getStart(sf) + 1, end: n.getEnd() - 2 });
    } else if (ts.isTemplateTail(n)) {
      // }tail`
      blanks.push({ pos: n.getStart(sf) + 1, end: n.getEnd() - 1 });
    }
    n.forEachChild(walk);
  };
  walk(sf);
  blanks.sort((a, b) => a.pos - b.pos);

  let out = "";
  let last = 0;
  for (const b of blanks) {
    if (b.pos < last || b.end < b.pos) continue;
    out += src.slice(last, b.pos);
    last = b.end;
  }
  return out + src.slice(last);
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
