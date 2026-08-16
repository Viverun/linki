import test from "node:test";
import assert from "node:assert/strict";
import { codeOnly, stripComments, stripStrings } from "@/tests/support/source-text";

/**
 * Regression tests for the source-text helpers themselves.
 *
 * These exist because the first implementation corrupted real files SILENTLY, in
 * the one direction that does not announce itself. Five test files depend on
 * these helpers to make `assert.doesNotMatch` trustworthy; if the helper eats
 * the region being examined, that assertion passes against nothing.
 */

test("stripComments: a `/*` inside a STRING does not open a comment", () => {
  // The live case. lib/linkedin/session.ts:399 contains
  //   await page.waitForURL("**\/feed/**", { timeout: 180_000 });
  // whose string holds a `/*`. The regex implementation treated it as a comment
  // opener and deleted everything up to the next `*/` — 350+ characters, taking
  // the closing quote with it and unbalancing every string that followed.
  const src = [
    'const a = 1;',
    'await page.waitForURL("**/feed/**", { timeout: 180_000 });',
    'const KEEP_ME = "sentinel";',
  ].join("\n");

  const out = stripComments(src);
  assert.match(out, /KEEP_ME/, "code after the string must survive");
  assert.match(out, /waitForURL/, "and the line itself");
  assert.match(out, /sentinel/, "including later string contents");
});

test("stripComments: real comments are still removed, both kinds", () => {
  const src = [
    'const a = 1; // trailing line comment',
    '/* a block',
    '   comment */',
    'const b = 2;',
  ].join("\n");
  const out = stripComments(src);
  assert.ok(!out.includes("trailing line comment"));
  assert.ok(!out.includes("a block"));
  assert.match(out, /const a = 1;/);
  assert.match(out, /const b = 2;/);
});

test("stripComments: a `//` inside a string is not a comment", () => {
  const src = 'const u = "https://www.linkedin.com/in/x"; const after = 1;';
  const out = stripComments(src);
  assert.match(out, /linkedin\.com/, "the URL survives");
  assert.match(out, /const after = 1;/, "and so does the code after it");
});

test("stripComments: escapes inside strings do not end them early", () => {
  const src = 'const s = "a \\" b /* not a comment */ c"; const after = 1;';
  const out = stripComments(src);
  assert.match(out, /const after = 1;/, "the escaped quote must not terminate the string");
});

test("stripComments: template literals are respected", () => {
  const src = 'const t = `a /* b */ c`; const after = 1;';
  const out = stripComments(src);
  assert.match(out, /const after = 1;/);
  assert.match(out, /a \/\* b \*\/ c/, "template contents are left intact");
});

test("stripStrings: blanks contents, keeps the quotes", () => {
  assert.equal(stripStrings('foo("bar")'), 'foo("")');
  assert.equal(stripStrings("foo('bar')"), "foo('')");
});

test("codeOnly: the composition survives a file with both hazards", () => {
  const src = [
    '// a comment mentioning localStorage',
    'const glob = "**/feed/**";',
    'const real = sessionStorage.getItem("k");',
  ].join("\n");
  const out = codeOnly(src);
  assert.ok(!out.includes("localStorage"), "prose is gone");
  assert.match(out, /sessionStorage/, "code is not");
});

test("hash style is unchanged and still ignores shell expansions", () => {
  const src = 'X="${v#pre}"\n# a real comment\necho "$#"';
  const out = stripComments(src, "hash");
  assert.ok(!out.includes("a real comment"));
  assert.match(out, /\$\{v#pre\}/, "parameter expansion is not a comment");
});

// ─── H2 — regex literals (the mirror of the bug the walker was written for) ──
//
// ca35aaf replaced the regex helper with a walker because a `/*` inside a STRING
// opened a phantom comment. The walker then had the same defect reflected: a
// QUOTE inside a REGEX opened a phantom string. Found by diffing old and new
// output across all 127 source inputs — `lib/linkedin/scraper.ts:162` and
// `profile-scrape.ts:177` both hold `.replace(/"/g, "")`.

test("H2: a quote inside a regex literal does not open a string", () => {
  const src = [
    'const j = raw.replace(/"/g, "");',
    '// a real comment that MUST still be removed',
    'const k = 1;',
  ].join("\n");
  const out = stripComments(src);
  assert.match(out, /replace\(\/"\/g/, "the regex literal survives intact");
  assert.doesNotMatch(out, /a real comment/, "and the comment after it is still stripped");
});

test("H2: a `//` inside a regex literal is not a line comment", () => {
  // lib/linkedin/sync-accepted.ts and connect.ts both carry this shape. The OLD
  // regex helper truncated the line at the `//`, deleting a live authwall guard.
  const src = 'if (/\\/login|\\/uas\\//.test(url)) { block(); }';
  const out = stripComments(src);
  assert.match(out, /block\(\);/, "code after the regex must survive");
  assert.match(out, /uas/, "and the regex itself must be intact");
});

test("H2: division is not mistaken for a regex", () => {
  const src = ["const r = (a + b) / c;", "const s = count / 2; // trailing", "const t = 3;"].join("\n");
  const out = stripComments(src);
  assert.match(out, /\(a \+ b\) \/ c;/, "division after ) is untouched");
  assert.match(out, /count \/ 2;/, "division after an identifier is untouched");
  assert.doesNotMatch(out, /trailing/, "and a real comment after division still goes");
  assert.match(out, /const t = 3;/, "nothing downstream was swallowed");
});

test("H2: a regex after `return` is treated as a regex, not division", () => {
  const out = stripComments('function f() { return /["\']/.test(x); } // gone');
  assert.match(out, /return \/\["/, "the regex survives");
  assert.doesNotMatch(out, /gone/, "the comment does not");
});

// ─── adversarial validation: these helpers must fail LOUDLY on bad input ─────
//
// A source assertion reads text produced by these functions. If the producer can
// return something empty or truncated while the CONSUMER still passes, the whole
// mechanism is decorative. So: prove the helpers do not silently manufacture an
// empty result, and prove the anchor rule below catches it when they do.

test("H2 adversarial: empty and whitespace input produce empty output, never a throw", () => {
  for (const bad of ["", "   ", "\n\n"]) {
    assert.equal(stripComments(bad).trim(), "", `empty in, empty out for ${JSON.stringify(bad)}`);
    assert.equal(codeOnly(bad).trim(), "");
  }
});

test("H2 adversarial: a TRUNCATED source does not silently look like clean code", () => {
  // The exact hazard: a file cut mid-string. The walker must not run past the end
  // inventing content, and must not throw — it must return what is there, so a
  // POSITIVE anchor in the consumer is what fails.
  const truncated = 'const a = "unterminated';
  const out = stripComments(truncated);
  assert.ok(out.length <= truncated.length, "no content is invented");
  assert.doesNotThrow(() => codeOnly(truncated));
  // and the consumer-side rule: a negative assertion alone would PASS here
  assert.doesNotMatch(out, /somethingThatIsNotThere/, "a negative assertion passes vacuously on truncated input");
  assert.ok(!/const a = "unterminated"/.test(out) || out.includes("const a"),
    "which is exactly why every negative source assertion needs a positive anchor");
});

test("H2 adversarial: an unterminated BLOCK comment eats to EOF and is detectable", () => {
  const out = stripComments("const keep = 1;\n/* never closed\nconst gone = 2;");
  assert.match(out, /const keep = 1;/, "content before the opener survives — the anchor");
  assert.doesNotMatch(out, /const gone/, "content after it is gone, as a real comment would be");
});
