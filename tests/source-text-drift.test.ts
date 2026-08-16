import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * H2 (2026-08-16). `ca35aaf` replaced the shared `stripComments` with a walker
 * because the regex version deleted live code. It did not find the two PRIVATE
 * COPIES of that same regex:
 *
 *   tests/health-isolation.test.ts:36  stripCommentsAndStrings()
 *   lib/linkedin/connect.test.ts:459   codeOnlyConnect()
 *
 * Both kept the defect for three days after it was "fixed", and both were
 * actively corrupting their inputs — `connect.ts`'s
 * `const HARD_WALL_RE = /\/authwall\b|\/checkpoint\//;` was being truncated at
 * the `//` inside the regex literal, in the very file whose call ORDER those
 * assertions exist to protect.
 *
 * NF-10's tripwire guards host expressions. This one guards the comment-stripping
 * helper, on the same principle: a fix applied to one of N copies is not a fix,
 * and prose asking people to reuse the helper is not a check.
 */

const ROOT = join(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", ".next", ".git", "data", "playwright-browsers", "public", ".claude", "ee"]);

/** The shape of the old regex, in both its forms. */
const OLD_BLOCK_RE = /replace\(\s*\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\//;
const OLD_LINE_RE = /replace\(\s*\/\(\^\|\[\^:\]\)\\\/\\\//;

/** The single site allowed to define comment stripping. */
const OWNER = "tests/support/source-text.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e)) out.push(p);
  }
  return out;
}

const files = walk(ROOT).map(p => p.replace(ROOT + "/", ""));

test("H2: no file re-implements the old comment-stripping regex", () => {
  const offenders: string[] = [];
  for (const rel of files) {
    if (rel === OWNER) continue;                 // the walker's own doc quotes it
    if (rel === "tests/source-text-drift.test.ts") continue;   // this file names it
    const src = readFileSync(join(ROOT, rel), "utf8");
    if (OLD_BLOCK_RE.test(src) || OLD_LINE_RE.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    "these files carry a private copy of the old regex comment-stripper. Import " +
    "codeOnly/stripComments from tests/support/source-text instead — a copy does " +
    "not receive the next fix, and both previous copies were corrupting live code.");
});

test("H2 guard-the-guard: the tripwire can actually see the shape it forbids", () => {
  // A drift test that cannot match its own target is the failure mode this whole
  // area exists to prevent, so assert the pattern against the literal old source.
  const oldBlock = String.raw`src.replace(/\/\*[\s\S]*?\*\//g, " ")`;
  const oldLine = String.raw`src.replace(/(^|[^:])\/\/.*$/gm, "$1 ")`;
  assert.ok(OLD_BLOCK_RE.test(oldBlock), "the block-comment pattern must match the old code");
  assert.ok(OLD_LINE_RE.test(oldLine), "the line-comment pattern must match the old code");
});

test("H2: the two migrated consumers delegate rather than re-implement", () => {
  for (const rel of ["tests/health-isolation.test.ts", "lib/linkedin/connect.test.ts"]) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.match(src, /from "@\/tests\/support\/source-text"/,
      `${rel} must import the shared helper`);
  }
});
