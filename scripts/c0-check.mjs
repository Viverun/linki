import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

assert.notEqual(process.getuid(), 0);
assert.equal(process.version, "v22.23.0");
assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal));
assert.equal(process.env.ALERT_WEBHOOK_URL, undefined);
assert.equal(process.env.BACKUP_OFFSITE_DIR, undefined);
assert.equal(process.env.BACKUP_DIR, undefined);
assert.equal(process.env.BACKUP_RETAIN, undefined);

const server = createServer((_req, res) => res.end("c0-loopback"));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, { signal: AbortSignal.timeout(5000) });
  assert.equal(await response.text(), "c0-loopback");
} finally {
  await new Promise(resolve => server.close(resolve));
}
await new Promise((resolve, reject) => {
  const socket = createConnection({ host: "192.0.2.1", port: 80 });
  socket.setTimeout(2000, () => socket.destroy(new Error("Egress probe timed out instead of failing closed")));
  socket.once("connect", () => socket.destroy(new Error("External network unexpectedly reachable")));
  socket.once("error", error => {
    if (error.code === "ENETUNREACH" || error.code === "EHOSTUNREACH") resolve();
    else reject(error);
  });
});
console.log("C0 isolation PASS: non-root, loopback available, external network unreachable, clean environment");
mkdirSync("/tmp/home", { recursive: true });
// Snapshot files are copied as root; tests run as uid 1000, so git refuses
// /work as "dubious ownership" and source-text-corpus fails. Whitelist it.
spawnSync("git", ["config", "--global", "--add", "safe.directory", "/work"]);
// WORK MUST BE EXECUTABLE: the tmpfs at /tmp is noexec (correct for scratch
// data), but node_modules holds native addons (.node) and .bin shims that must
// map/exec. /work is a dedicated exec tmpfs; c0-fallback.db and other scratch
// state stay on the noexec /tmp. Verified: dlopen of a native binding fails
// with "failed to map segment" on a noexec tmpfs and loads on an exec one.
cpSync("/opt/source", "/work", { recursive: true });
cpSync("/opt/deps/node_modules", "/work/node_modules", { recursive: true });
const checks = [
  ["npm-version", "npm", ["--version"]],
  ["native-sqlite", "node", ["-e", "const db = require('better-sqlite3')(':memory:'); db.close()"]],
  ["typegen", "node", ["node_modules/next/dist/bin/next", "typegen"]],
  ["typecheck", "npm", ["run", "typecheck"]],
  ["tests", "npm", ["test", "--", "--test-reporter=tap"]],
  ["lint", "npm", ["run", "lint", "--", "--max-warnings=0"]],
  // C0-F2 root cause (isolated 2026-09-17): under Node 22 in the verification
  // container, `next build` spawned THROUGH `npm run build` fails 8/8 with
  // "TypeError: Cannot read properties of null (reading 'useState')" during
  // prerender (varying page per run), while the identical direct invocation
  // (`node node_modules/next/dist/bin/next build`) passes in the same workspace
  // seconds later (A/B: npm=1, direct=0, twice; 15/15 passes in sh-parent too).
  // Wrapper-dependent, workspace-independent, page-independent -> npm layer.
  // The gate therefore invokes the build exactly as the Dockerfile image does,
  // with the prebuild mirror step run explicitly first.
  ["prebuild", "node", ["scripts/mirror-ee.mjs"]],
  ["build", "node", ["node_modules/next/dist/bin/next", "build"]],
];
// C0 recorded lint without gating on it (debt C0-L1: 21 errors / 13 warnings
// at the audit revision). That debt was cleared in C0, and C1 acceptance
// requires lint success alongside tests, typecheck and build, so every check
// is mandatory from C1 on.
const results = [];
for (const [name, command, args] of checks) {
  console.log(`C0 CHECK ${name}: ${command} ${args.join(" ")}`);
  const start = Date.now();
  // Capture to a file instead of stdio:inherit. Hypothesis C0-F2: interleaving
  // ~100s of tests+lint output with the build's own output through one
  // inherited pipe correlates 4/4 with the gate's Turbopack prerender-worker
  // crash ("Cannot read properties of null (reading 'useState')" on a varying
  // page), while file-redirected builds passed 14/14. This also retains the
  // FULL log of every check for evidence instead of interleaved tails.
  const result = spawnSync(command, args, {
    cwd: "/work", timeout: 300000, killSignal: "SIGKILL",
    env: { ...process.env, NODE_ENV: name === "build" || name === "prebuild" ? "production" : "test" },
    encoding: "utf8", maxBuffer: 512 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(`/tmp/c0-${name}.log`, output);
  if (result.status !== 0) {
    // Failure evidence must be COMPLETE, not a tail: the gate's prerender
    // crash has never been diagnosed because only the last lines survived.
    console.log(`C0 ${name} FAILED — full output:\n${output}`);
  } else {
    const tail = output.split("\n").filter(Boolean).slice(-6).join("\n");
    if (tail) console.log(`C0 ${name} tail:\n${tail}`);
  }
  results.push({ name, exitCode: result.status, signal: result.signal, error: result.error?.message, durationMs: Date.now() - start });
  console.log(`C0 RESULT ${JSON.stringify(results.at(-1))}`);
}
const mandatory = results.every(result => result.exitCode === 0);
const lintResult = results.find(result => result.name === "lint");
console.log(`C0 LINT: ${lintResult?.exitCode === 0 ? "clean" : "FAILED (mandatory since C1)"}`);
console.log(`C0 SUMMARY ${JSON.stringify({ node: process.version, arch: process.arch, gate: mandatory, results })}`);
process.exitCode = mandatory ? 0 : 1;
