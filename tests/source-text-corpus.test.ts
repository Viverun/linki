import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import ts from "typescript";
import { codeOnly, stripComments } from "@/tests/support/source-text";

/**
 * Y4 — the differential corpus test. This is the one that settles it.
 *
 * Three trigger shapes have now corrupted this repo's source-text helpers, each
 * found only after the fact and each in a lexical context the previous
 * hand-rolled implementation did not model:
 *
 *   1. `/*` inside a STRING   — regex version, ate 1905 chars of session.ts
 *   2. `//` inside a REGEX    — regex version, truncated live authwall guards
 *   3. a QUOTE inside a REGEX — walker version, left real comments unstripped
 *
 * Enumerating known shapes cannot catch a fourth. This does, by asserting a
 * property instead: **removing comments must not change the token stream.**
 *
 * For every tracked source file: tokenize `src` and `codeOnly(src)` with TS's
 * scanner, drop comments and trivia, and require the two streams to be
 * identical. Any deletion, truncation or quote-mispairing changes the stream.
 *
 * The scanner is used identically on both sides, so even where it is imperfect
 * the comparison stays valid: an identical imperfection cancels, while real
 * corruption does not.
 */

const ROOT = join(import.meta.dirname, "..");

/** Every tracked source file git knows about, in the JS/TS family. */
function trackedSources(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0")
    .filter(Boolean)
    .filter(f => /\.(ts|tsx|mjs|js)$/.test(f))
    .filter(f => !f.startsWith("node_modules/"));
}

/**
 * Token stream with comments and trivia removed.
 *
 * Uses the PARSER, not `ts.createScanner` directly. A first version of this test
 * used the raw scanner and reported 15 files as corrupted — every one a false
 * positive, because a bare scanner cannot resolve regex-vs-division or JSX
 * without parser context, so a single `/` or `<` desynchronised the rest of the
 * stream. Verified by hand on `lib/health-contract.ts`, the smallest flagged
 * file, whose output was perfectly correct.
 *
 * That is the same mistake this file exists to catch, made in the checking tool
 * — which is why the tool now delegates to the parser too.
 */
function tokens(src: string): string[] {
  const sf = ts.createSourceFile("__corpus__.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const walk = (n: ts.Node) => {
    // JSDoc nodes ARE comments — `getChildren()` surfaces them as real nodes, so
    // they must be excluded or every documented file "diverges" for the correct
    // reason. (The second false positive this test produced; both were in the
    // checker, not the helper.)
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = n.getChildren(sf);
    if (kids.length === 0) {
      if (n.kind !== ts.SyntaxKind.EndOfFileToken) out.push(`${n.kind}:${n.getText(sf)}`);
      return;
    }
    for (const k of kids) walk(k);
  };
  walk(sf);
  return out;
}

const FILES = trackedSources();

test("Y4: the corpus is non-trivial", () => {
  // Anchor. A corpus test that silently covers zero files is the vacuous-pass
  // shape this whole area exists to prevent.
  assert.ok(FILES.length > 50, `expected a real corpus, got ${FILES.length} files`);
});

test("Y4: stripping comments never changes the token stream, across every tracked source file", () => {
  const broken: string[] = [];
  for (const rel of FILES) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    let before: string[], after: string[];
    try {
      before = tokens(src);
      after = tokens(stripComments(src));
    } catch (e) {
      broken.push(`${rel} (scanner threw: ${(e as Error).message})`);
      continue;
    }
    if (before.length !== after.length || before.some((t, i) => t !== after[i])) {
      const at = before.findIndex((t, i) => t !== after[i]);
      broken.push(`${rel} — first divergence at token ${at}: ${JSON.stringify(before[at])} -> ${JSON.stringify(after[at])}`);
    }
  }
  assert.deepEqual(broken, [],
    `these files are CORRUPTED by stripComments. Every assertion reading one of ` +
    `them may have been passing vacuously — enumerate them before fixing, per X2.`);
});

test("Y4: codeOnly never invents or deletes tokens beyond string CONTENTS", () => {
  // codeOnly also blanks string contents, so the streams differ by design inside
  // literals — but the token COUNT and the shape of every non-literal token must
  // still match, or code was destroyed rather than blanked.
  const broken: string[] = [];
  for (const rel of FILES) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    const before = tokens(src);
    const after = tokens(codeOnly(src));
    if (before.length !== after.length) {
      broken.push(`${rel} — token count ${before.length} -> ${after.length}`);
      continue;
    }
    const kindsBefore = before.map(t => t.slice(0, t.indexOf(":")));
    const kindsAfter = after.map(t => t.slice(0, t.indexOf(":")));
    const at = kindsBefore.findIndex((k, i) => k !== kindsAfter[i]);
    if (at !== -1) broken.push(`${rel} — token KIND changed at ${at}: ${before[at]} -> ${after[at]}`);
  }
  assert.deepEqual(broken, [], "codeOnly must blank string contents, never restructure code");
});

// ─── the shell path: cheaper guard, because the risk class does not apply ────

test("Y4: hash-style stripping is non-destructive on every tracked shell script", () => {
  const shells = execFileSync("git", ["ls-files", "-z", "*.sh"], { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter(Boolean);
  assert.ok(shells.length > 0, "anchor: there are shell scripts to check");
  for (const rel of shells) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    const out = stripComments(src, "hash");
    assert.ok(src.trim().length > 0, `anchor: ${rel} is non-empty`);
    assert.ok(out.trim().length > 0, `${rel}: non-empty input must give non-empty output`);
    // Positive anchor per consumer: the thing each script exists to do survives.
    if (rel.endsWith("watchdog.sh")) assert.match(out, /health-predicate\.js/, `${rel}: lost its predicate call`);
    if (rel.endsWith("preflight.sh")) assert.match(out, /npm test|tsc/, `${rel}: lost its gates`);
    if (rel.endsWith("mutate.sh")) assert.match(out, /node --experimental-strip-types/, `${rel}: lost its runner`);
  }
});
