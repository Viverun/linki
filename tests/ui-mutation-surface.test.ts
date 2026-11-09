import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codeOnly } from "./support/source-text";

/**
 * PR-15 (C3) — the complete mutation-surface inventory.
 *
 * The register's finding was "UI false-success: mutation responses are
 * discarded at [four examples]... These are examples, not a full handler
 * audit." A structural assertion over the whole tree is what turns that into
 * an exhaustive claim: every mutation call site is enumerated here, so a new
 * handler that ignores its response fails the gate instead of shipping.
 *
 * Three invariants, all mechanical:
 *
 *  1. Every request with a mutating method goes through `mutateFetch`, which
 *     never rejects on a transport failure (`lib/ui-mutation.ts`).
 *  2. Every `if (!X.ok)` error branch parses defensively — no bare
 *     `await X.json()`, which throws on the HTML body a 5xx actually returns.
 *  3. Every handler that mutates checks `.ok` before reporting success or
 *     updating local state (the original false-success defect).
 */

const root = join(import.meta.dirname, "..");

/** Comments removed, strings kept: URLs and messages are part of the shape. */
function source(file: string): string {
  return codeOnly(readFileSync(join(root, file), "utf8"), { strings: false });
}

/**
 * Hand-rolled walk rather than `fs.globSync`, which is still experimental on
 * the pinned Node 22 and would make this suite's discovery depend on a runtime
 * flag. Same reasoning as the Node 22/24 differential already recorded.
 */
function tsxUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxUnder(rel));
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) out.push(rel);
  }
  return out;
}

const FILES: string[] = [...tsxUnder("pages"), ...tsxUnder("components")].sort();

const MUTATION = /method:\s*"(POST|PATCH|PUT|DELETE)"/g;

interface Site {
  file: string;
  line: number;
  method: string;
  /** Text from the enclosing call's identifier back a little, for diagnosis. */
  callee: string;
}

/** Every mutating request in the app, with the function it is issued by. */
function mutationSites(): Site[] {
  const sites: Site[] = [];
  for (const file of FILES) {
    const src = source(file);
    for (const m of src.matchAll(MUTATION)) {
      const before = src.slice(0, m.index);
      const callStart = Math.max(
        before.lastIndexOf("mutateFetch("),
        before.lastIndexOf("fetch(")
      );
      const callee = callStart === -1 ? "<none>" : src.slice(callStart, callStart + 12).split("(")[0];
      sites.push({
        file,
        line: before.split("\n").length,
        method: m[1],
        callee,
      });
    }
  }
  return sites;
}

/** The `function` whose body contains `index`. */
function enclosingHandler(src: string, index: number): string {
  const decls = [...src.slice(0, index).matchAll(/(?:async\s+)?function\s+\w+\s*\(/g)];
  const decl = decls.at(-1);
  if (!decl?.index) return "<component body>";
  const rest = src.slice(decl.index);
  const next = rest.slice(1).search(/\n {2}(?:async\s+)?function\s/);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  const name = /function\s+(\w+)/.exec(body)?.[1] ?? "<anonymous>";
  return name;
}

test("the inventory actually found the mutation surface (guards against a vacuous pass)", () => {
  const sites = mutationSites();
  // 72 at the time PR-15 was closed. A floor, not an equality: adding handlers
  // must not require editing this number, but silently finding nothing must fail.
  assert.ok(sites.length >= 70, `expected the full surface, found ${sites.length}`);
  const files = new Set(sites.map((s) => s.file));
  assert.ok(files.size >= 10, `expected >=10 files with mutations, found ${files.size}`);
});

test("every mutating request goes through mutateFetch (transport failure cannot reject)", () => {
  const offenders = mutationSites().filter((s) => s.callee !== "mutateFetch");
  assert.deepEqual(
    offenders.map((s) => `${s.file}:${s.line} ${s.method} via ${s.callee}`),
    [],
    "a raw fetch() with a mutating method will reject on a network failure"
  );
});

test("no error branch parses a body without guarding it (5xx HTML must not throw)", () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    const src = source(file);
    for (const m of src.matchAll(/if \(!(\w+)\.ok\)\s*\{/g)) {
      const name = m[1];
      const open = (m.index ?? 0) + m[0].length - 1;
      let depth = 0;
      let close = open;
      for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) { close = i; break; }
        }
      }
      const branch = src.slice(open, close + 1);
      // `?.json().catch(...)` is defensive; a bare `await x.json()` is not.
      const bare = new RegExp(`await ${name}\\.json\\(\\)(?!\\s*\\.catch)`).test(branch);
      if (bare) offenders.push(`${file}:${src.slice(0, m.index).split("\n").length} (!${name}.ok)`);
    }
  }
  assert.deepEqual(offenders, [], "use readError() — this throws on an HTML error page");
});

test("every handler that mutates checks .ok before reporting success", () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    const src = source(file);
    const seen = new Set<string>();
    for (const m of src.matchAll(MUTATION)) {
      const handler = enclosingHandler(src, m.index);
      if (seen.has(handler)) continue;
      seen.add(handler);
      const decl = [...src.slice(0, m.index).matchAll(/(?:async\s+)?function\s+\w+\s*\(/g)].at(-1);
      const rest = decl?.index ? src.slice(decl.index) : src;
      const next = rest.slice(1).search(/\n {2}(?:async\s+)?function\s/);
      const body = next === -1 ? rest : rest.slice(0, next + 1);
      if (!/\.ok\b/.test(body) && !/readError\(/.test(body)) {
        offenders.push(`${file} :: ${handler}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "a refused mutation must not be rendered as success");
});

/**
 * PR-15's ambiguous-outcome clause, measured rather than assumed.
 *
 * `!res.ok` reports a lost response and a refused request identically, and the
 * first may mean the mutation landed. `mutationOutcome` makes the distinction
 * and `reconcileMutation` resolves it by reading — never by re-sending.
 *
 * Wiring that through all ~70 call sites is a per-flow job (each needs to know
 * which resource to re-read), so it is deliberately partial and the debt is made
 * visible here: a handler either reconciles, or it is counted. The ceiling can
 * only go down, which stops the gap from growing while the rest is worked
 * through, and stops this test from passing vacuously.
 */
const RECONCILED_MINIMUM = 2;
// Measured 2026-11-09 with twenty-two handlers wired (lists create/delete/import-cancel,
// companies create-update/delete, all six on the campaigns page, and eleven on the
// campaign detail page). It may only go DOWN: a new handler that ignores ambiguity
// fails here rather than adding to the count, which is the point of a ceiling rather
// than a list.
const UNRECONCILED_CEILING = 38;

/** Every function that issues a mutating request, with its body. */
function mutatingHandlers(): Array<{ id: string; body: string }> {
  const out: Array<{ id: string; body: string }> = [];
  const seen = new Set<string>();
  for (const file of FILES) {
    const src = source(file);
    for (const m of src.matchAll(MUTATION)) {
      const handler = enclosingHandler(src, m.index);
      const id = `${file} :: ${handler}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const decl = [...src.slice(0, m.index).matchAll(/(?:async\s+)?function\s+\w+\s*\(/g)].at(-1);
      const rest = decl?.index ? src.slice(decl.index) : src;
      const next = rest.slice(1).search(/\n {2}(?:async\s+)?function\s/);
      out.push({ id, body: next === -1 ? rest : rest.slice(0, next + 1) });
    }
  }
  return out;
}

test("an ambiguous outcome is either reconciled or counted as debt, never reported as failure", () => {
  const handlers = mutatingHandlers();
  const reconciled = handlers.filter((h) => /mutationOutcome\(/.test(h.body));
  const pending = handlers.filter((h) => !/mutationOutcome\(/.test(h.body));

  for (const h of reconciled) {
    // Classifying without reconciling would be worse than not classifying: it
    // would relabel the ambiguity and still report it as failure.
    assert.match(
      h.body,
      /reconcileMutation\(/,
      `${h.id} classifies the outcome but never verifies it`
    );
  }

  assert.ok(
    reconciled.length >= RECONCILED_MINIMUM,
    `expected at least ${RECONCILED_MINIMUM} reconciled handlers, found ${reconciled.length}`
  );
  assert.ok(
    pending.length <= UNRECONCILED_CEILING,
    `unreconciled mutating handlers grew past ${UNRECONCILED_CEILING} (now ${pending.length}); ` +
      `wire the new one through mutationOutcome/reconcileMutation instead of raising the ceiling.\n` +
      pending.map((p) => `  - ${p.id}`).join("\n")
  );
});
