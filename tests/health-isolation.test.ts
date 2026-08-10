import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * THE ISOLATION INVARIANT
 *
 *   The endpoint that decides whether to restart must not depend on the
 *   subsystem it judges.
 *
 * P2-2 nearly shipped the violation: `/api/health` imported a constant from
 * `lib/linkedin/runner.ts`, which pulls playwright, apollo, nodemailer and the
 * crypto helpers in at module scope. An import-time throw anywhere in that graph
 * makes health return 500; the supervisor reads 500 as "unhealthy" and restarts;
 * a restart cannot fix a module that fails to load. The restart budget then
 * burns down against something it can never repair, and the one mechanism meant
 * to recover the system is consumed by the thing it cannot recover.
 *
 * That was caught by reading the import graph by hand. It was then "protected"
 * by a comment — and MB9 established that a comment protects nothing.
 *
 * This test walks the TRANSITIVE graph, because the hazard arrived one hop away:
 * health.ts's own import list looked entirely reasonable. Asserting on direct
 * imports would have passed while the violation was live.
 */

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Import specifiers are extracted from source text rather than from a resolver,
 * so comments and strings are stripped first — §2's standing rule. A commented-out
 * `import { x } from "@/lib/linkedin/runner"` is not an edge, and a test that
 * counted it would fail for a reason that does not exist.
 */
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

/** Static imports, re-exports, dynamic import() and require(). */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

function importsOf(file: string): string[] {
  const src = stripCommentsAndStrings(readFileSync(file, "utf8"));
  const found = new Set<string>();
  for (const m of src.matchAll(SPECIFIER_RE)) found.add(m[1]);
  return [...found];
}

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Resolves a specifier to a repo-relative file, or returns a `pkg:` marker for
 * anything that is not local source. Node builtins are marked too — they are
 * never denied, but naming them keeps the reported path readable.
 */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  if (spec.startsWith("node:")) return `pkg:${spec}`;

  let base: string | null = null;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return `pkg:${spec}`; // bare specifier — a package, or a builtin like "crypto"

  const candidates = [
    base,
    ...EXTENSIONS.map(e => base + e),
    ...EXTENSIONS.map(e => join(base!, "index" + e)),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null; // unresolvable — a type-only path or a package with a scoped name
}

/** Walks the transitive graph, returning every reachable node with the path taken. */
function reachableFrom(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: Array<{ file: string; path: string[] }> = [{ file: entry, path: [relative(ROOT, entry)] }];

  while (queue.length > 0) {
    const { file, path } = queue.shift()!;
    for (const spec of importsOf(file)) {
      const target = resolveSpecifier(spec, file);
      if (target === null) continue;

      const label = target.startsWith("pkg:") ? target : relative(ROOT, target);
      if (seen.has(label)) continue;
      const nextPath = [...path, label];
      seen.set(label, nextPath);

      if (!target.startsWith("pkg:")) queue.push({ file: target, path: nextPath });
    }
  }
  return seen;
}

/**
 * What the health path may never reach.
 *
 * These are not banned for being large. They are banned for being the subsystem
 * under judgement (the runner and everything it drives) or for being heavy
 * third-party modules whose import-time failure would be indistinguishable, from
 * the supervisor's side, from a dead runner.
 */
const DENIED = [
  // The subsystem under judgement.
  "lib/linkedin/",
  "lib/apollo",
  "lib/email/",
  "lib/premium",
  // Its heavyweight dependencies, denied by name so a future re-route through a
  // differently-named local wrapper still trips.
  "pkg:playwright",
  "pkg:playwright-extra",
  "pkg:playwright-core",
  "pkg:nodemailer",
  "pkg:imap-simple",
  "pkg:mailparser",
  "pkg:openai",
];

function assertIsolated(entry: string) {
  const reachable = reachableFrom(join(ROOT, entry));

  // One entry per banned prefix, showing the SHORTEST route in (the walk is a
  // BFS, so the first path found to any node is a shortest one) plus how many
  // modules under that prefix came with it. Listing every reachable node instead
  // produced forty near-identical blocks and buried the one hop that mattered —
  // the message has to be read at the moment someone's build just broke.
  const worst = new Map<string, { path: string[]; count: number }>();
  for (const [label, path] of reachable) {
    for (const denied of DENIED) {
      if (!label.startsWith(denied)) continue;
      const existing = worst.get(denied);
      if (!existing) worst.set(denied, { path, count: 1 });
      else {
        existing.count++;
        if (path.length < existing.path.length) existing.path = path;
      }
    }
  }

  const violations = [...worst].map(([denied, { path, count }]) =>
    `  ${denied}  (${count} module${count === 1 ? "" : "s"} reached)\n` +
    `      ${path.join("\n        -> ")}`
  );

  assert.equal(
    violations.length, 0,
    `${entry} transitively reaches banned modules.\n\n` +
    violations.join("\n\n") +
    `\n\nThe endpoint that decides whether to restart must not depend on the\n` +
    `subsystem it judges: an import-time throw in that graph makes health 500,\n` +
    `the supervisor restarts, and a restart cannot fix a module that will not\n` +
    `load. Move the shared value into lib/health-contract.ts (a dependency-free\n` +
    `leaf) rather than importing it from the runner.\n`
  );
}

test("§1: /api/health transitively reaches nothing it is meant to judge", () => {
  assertIsolated("pages/api/health.ts");
});

test("§1: lib/health-contract.ts is a leaf and stays one", () => {
  const reachable = reachableFrom(join(ROOT, "lib/health-contract.ts"));
  assert.deepEqual(
    [...reachable.keys()], [],
    `lib/health-contract.ts must import NOTHING — it is the module both the runner ` +
    `and the health endpoint depend on, so anything it pulls in is pulled into ` +
    `health too. Reached: ${[...reachable.keys()].join(", ")}`
  );
});

test("§1: the walker actually walks — a known deep path is found", () => {
  // Guards the guard. If resolveSpecifier silently returned null for everything,
  // every isolation assertion above would pass vacuously. runner.ts is the
  // module the invariant is about, so prove the walker can see through it to the
  // heavyweight dependency two hops down.
  const reachable = reachableFrom(join(ROOT, "lib/linkedin/runner.ts"));
  assert.ok(reachable.size > 10, `expected a large graph from runner.ts, got ${reachable.size}`);
  assert.ok(
    [...reachable.keys()].some(k => k.startsWith("pkg:playwright")),
    "the walker must reach playwright FROM runner.ts (via session.ts) — if it " +
    "cannot, the isolation tests above are passing vacuously"
  );
  const path = reachable.get("lib/linkedin/session.ts");
  assert.ok(path && path.length >= 2, "and must record the path it took");
});

test("§1: scripts/health-predicate.js has no dependencies at all", () => {
  // It runs as the container's healthcheck command. A missing or broken module
  // there means the healthcheck itself fails, which the supervisor reads as an
  // unhealthy container — the same false-restart loop, one layer out.
  const src = stripCommentsAndStrings(readFileSync(join(ROOT, "scripts/health-predicate.js"), "utf8"));
  const specs = [...src.matchAll(SPECIFIER_RE)].map(m => m[1]);
  assert.deepEqual(
    specs, [],
    `scripts/health-predicate.js must require nothing, not even a builtin: it is ` +
    `the container healthcheck, and it must run under the leanest possible ` +
    `conditions. Found: ${specs.join(", ")}`
  );
});
