import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { childEnv } from "./support/child-env";

/**
 * PR-17 (C4) — the operational half: restore from the secondary, with the key
 * supplied from a place that is not the backup.
 *
 * `scripts/restore-rehearsal.mjs` builds a synthetic installation, backs it up
 * through the shipping `createBackup` (primary and secondary), escrows a
 * synthetic NEXTAUTH_SECRET outside both directories, deletes the primary to
 * simulate losing that location, and restores from the secondary in a clean
 * process.
 *
 * The second test is the one that makes the first mean anything: with the
 * escrowed secret replaced, the same rehearsal must FAIL. A restore test that
 * passes with the wrong key proves the drill is not actually checking the pair —
 * which is the whole hazard this clause exists for, since a backup restored
 * without its key is rows nobody can decrypt.
 */

const REPO = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO, "scripts", "restore-rehearsal.mjs");

function rehearse(tamper = false) {
  const args = [
    "--experimental-strip-types",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--import", join(REPO, "scripts", "test-setup.mjs"),
    SCRIPT,
  ];
  if (tamper) args.push("--tamper");

  const r = spawnSync(process.execPath, args, {
    cwd: REPO,
    // A fixture process, not a test run: without this the runner's markers would
    // make the bootstrap redirect the environment the rehearsal constructs.
    env: childEnv(),
    encoding: "utf8",
    timeout: 60_000,
  });

  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { status: r.status ?? -1, output };
}

test("a backup restores from the secondary using separately escrowed key material", () => {
  const { status, output } = rehearse();

  assert.equal(status, 0, output);
  assert.match(output, /DRILL PASSED/);
  assert.match(output, /8\/8 checks passed/);
  assert.match(output, /PASS\s+account session decrypts \(correct secret\)/);
  assert.match(output, /PASS\s+wrong secret CANNOT decrypt/, "the drill's own negative control still runs");
  assert.match(output, /REHEARSAL \{[^}]*"result":"PASSED"/);
  assert.match(output, /"escrowSeparateFromBackups":true/, "the key is not stored with the backup");
});

test("the same rehearsal fails when the escrowed key is wrong", () => {
  const { status, output } = rehearse(true);

  assert.equal(status, 1, `a wrong key must not restore successfully:\n${output}`);
  assert.match(output, /DRILL FAILED: account session decrypts \(correct secret\)/);
  assert.match(output, /REHEARSAL \{[^}]*"result":"FAILED"/);
  assert.match(output, /"tampered":true/);
});

test("the rehearsal never prints the session it is validating", () => {
  // The drill reports cookie NAMES and a count. If a future change starts
  // logging the decrypted payload, this fails rather than quietly writing a
  // working LinkedIn session into CI logs.
  const { output } = rehearse();

  assert.doesNotMatch(output, /synthetic-session-value-not-a-real-token/, "no cookie value may appear");
  assert.doesNotMatch(output, /"li_at"\s*:\s*"/, "no structured cookie payload may appear");
  assert.match(output, /li_at present/, "the shape is reported, which is what makes the check meaningful");
});
