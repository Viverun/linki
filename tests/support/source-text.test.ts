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
