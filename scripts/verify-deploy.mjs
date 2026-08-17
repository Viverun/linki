#!/usr/bin/env node
/**
 * Deploy / Gate-A verification, with ANCHORS.
 *
 * ── why this is a script and not a checklist ─────────────────────────────────
 *
 * Phase 2's step 5g reported PASS while nothing had executed: the save returned
 * 401, the step ids were therefore trivially unchanged, and "ids unchanged" was
 * read as success. A check that cannot distinguish
 *
 *     unchanged because the system behaved correctly
 *   from
 *     unchanged because the action never happened
 *
 * is not a check. Auditing the other eight steps found two more of the same
 * shape, both recorded in docs/operations.md:
 *
 *   - the supervisor predicate: a MISSING script exits 1 on this host, which is
 *     byte-identical to a genuine "restart needed" verdict. Asserting "non-zero"
 *     would pass with the predicate never running. Fixed by asserting the EXACT
 *     code AND an output string only the predicate itself can produce.
 *
 *   - zero-LinkedIn-navigation: the runner writes NO per-tick line to stdout, so
 *     the container log is 11 startup lines forever. `grep -c linkedin.com`
 *     returns 0 whether the runner is idle, busy, or dead — it cannot carry the
 *     evidence either way, and the `Tick —` count proposed as its anchor does
 *     not exist in this system. Re-anchored on the `logs` TABLE (which every
 *     step writes to), live chromium processes, and the runs/targets state.
 *
 * Every check below therefore has two parts: an ANCHOR that proves the
 * observation was actually taken, and only then the assertion.
 *
 * Usage:  node scripts/verify-deploy.mjs [--baseline <file>] [--save-baseline <file>]
 * Exit 0 = all pass. Exit 1 = at least one failure. Read-only against the DB.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CONTAINER = process.env.LINKI_CONTAINER || "linki-linki-1";
const HEALTH_URL = process.env.HEALTH_URL || "http://127.0.0.1:3456/api/health";
// Overridable ONLY so the anchor can be adversarially validated against a
// missing script — which exits 1 here, identical to a real "restart needed".
const PREDICATE = process.env.PREDICATE_PATH || "/app/scripts/health-predicate.js";

let failures = 0;
let checks = 0;

function report(name, ok, detail) {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** An anchor that does not hold makes every assertion after it meaningless. */
function anchor(name, ok, detail) {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? "anchor" : "ANCHOR FAILED"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

const inContainer = (js) =>
  execFileSync("docker", ["exec", CONTAINER, "node", "-e", js], { encoding: "utf8" });

/** Read-only DB query inside the container, returning parsed JSON. */
function dbJson(body) {
  const js = `const D=require('/app/node_modules/better-sqlite3');
    const db=new D('/data/linki.db',{readonly:true});
    const out=(()=>{${body}})();
    console.log(JSON.stringify(out)); db.close();`;
  return JSON.parse(inContainer(js));
}

function httpJson(url) {
  // Never throws: an unreachable endpoint must surface as a FAILED ANCHOR in the
  // summary, not as a crash that skips every later section and leaves the exit
  // code to whatever ran last.
  try {
    const raw = execFileSync("curl", ["-s", "--max-time", "10", url], { encoding: "utf8" });
    if (!raw.trim()) return { raw: "", json: null };
    return { raw, json: JSON.parse(raw) };
  } catch {
    return { raw: "", json: null };
  }
}

// ─── 1. schema ───────────────────────────────────────────────────────────────
console.log("\n[1] schema");
{
  const s = dbJson(`
    const cols = db.prepare('PRAGMA table_info(run_profile_tracks)').all().map(x=>x.name);
    const idx  = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r=>r.name);
    const tabs = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
    const c = require('crypto');
    const fp = c.createHash('sha256').update(
      db.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all().map(r=>r.sql).join('\\n')
    ).digest('hex');
    return { cols, idx, tabs, fp };`);
  // ANCHOR: a schema read that returns nothing would make every "missing" verdict vacuous.
  if (anchor("schema was actually read", s.cols.length > 5 && s.tabs.length > 20,
      `${s.cols.length} columns, ${s.tabs.length} tables`)) {
    report("current_step_id column", s.cols.includes("current_step_id"));
    report("ix_rpt_current_step_id", s.idx.includes("ix_rpt_current_step_id"));
    report("step_side_effects table", s.tabs.includes("step_side_effects"));
    report("ux_step_side_effects", s.idx.includes("ux_step_side_effects"));
    report("ix_step_side_effects_fingerprint", s.idx.includes("ix_step_side_effects_fingerprint"));
    report("fingerprint equals 88dff891…", s.fp.startsWith("88dff8914b1471e7"), s.fp.slice(0, 16));
  }
}

// ─── 2. backfill ─────────────────────────────────────────────────────────────
console.log("\n[2] backfill");
{
  const t = dbJson(`return db.prepare('SELECT id,state,current_step,current_step_id FROM run_profile_tracks').all();`);
  if (anchor("tracks were read", t.length > 0, `${t.length} tracks`)) {
    const term = t.filter(r => r.state === "completed" || r.state === "skipped");
    const non = t.filter(r => !(r.state === "completed" || r.state === "skipped"));
    report("every non-terminal track has a step id",
      non.length > 0 && non.every(r => r.current_step_id),
      `${non.filter(r => r.current_step_id).length}/${non.length}`);
    report("every terminal track has none",
      term.every(r => !r.current_step_id), `${term.filter(r => !r.current_step_id).length}/${term.length}`);
  }
}

// ─── 3. health contract ──────────────────────────────────────────────────────
console.log("\n[3] health contract");
{
  const { raw, json } = httpJson(HEALTH_URL);
  if (anchor("health endpoint answered", raw.length > 40 && json !== null, `${raw.length} bytes`)) {
    report("health_schema is 1", json.health_schema === 1, String(json.health_schema));
    report("restart_will_help PRESENT", Object.prototype.hasOwnProperty.call(json, "restart_will_help"),
      "absence = supervisor inert");
    report("runner state is healthy", json.runner?.state === "healthy", json.runner?.state);
    report("consecutive_tick_failures is 0", json.runner?.consecutive_tick_failures === 0);
  }
}

// ─── 4. supervisor predicate ─────────────────────────────────────────────────
console.log("\n[4] supervisor predicate (exact codes + proof it ran)");
{
  // A MISSING script exits 1 here, identical to a real "restart needed" verdict.
  // So each case asserts the EXACT code AND a string only the predicate emits.
  const cases = [
    ["dead + fixable", { health_schema: 1, runner: { state: "dead" }, restart_will_help: true }, 503, 1, /state=dead/],
    ["dead + NOT fixable", { health_schema: 1, runner: { state: "dead" }, restart_will_help: false }, 503, 0, /restart_will_help=false|NOT restarting/],
    ["healthy", { health_schema: 1, ok: true, runner: { state: "healthy" }, restart_will_help: false }, 200, 0, /state=healthy/],
  ];
  for (const [label, payload, status, expected, evidence] of cases) {
    const js = `
      const {createServer}=require('http'); const {execFile}=require('child_process');
      const srv=createServer((q,r)=>{r.writeHead(${status},{'content-type':'application/json'});r.end(${JSON.stringify(JSON.stringify(payload))})});
      srv.listen(0,'127.0.0.1',()=>{
        const p=srv.address().port;
        execFile('node',['${PREDICATE}','http://127.0.0.1:'+p+'/'],
          {env:{...process.env,HEALTH_PREDICATE_VERBOSE:'1'}},
          (e,so,se)=>{ srv.close(); console.log(JSON.stringify({code:e?(typeof e.code==='number'?e.code:-1):0, out:(so||'')+(se||'')})); });
      });`;
    const r = JSON.parse(inContainer(js));
    const ranIt = evidence.test(r.out);
    // ANCHOR first: did the predicate itself produce output? A missing or crashed
    // script yields an exit code with no output, and the code alone is ambiguous.
    if (anchor(`${label}: predicate produced its own output`, ranIt, JSON.stringify(r.out.trim()).slice(0, 70))) {
      report(`${label}: exit is exactly ${expected}`, r.code === expected, `exit ${r.code}`);
    }
  }
}

// ─── 5. zero LinkedIn activity ───────────────────────────────────────────────
console.log("\n[5] zero LinkedIn activity (NOT via the container log — see header)");
{
  const a = dbJson(`
    return {
      logs: db.prepare('SELECT COUNT(*) n FROM logs').get().n,
      newest: (db.prepare('SELECT created_at FROM logs ORDER BY created_at DESC LIMIT 1').get()||{}).created_at,
      running: db.prepare("SELECT COUNT(*) n FROM runs WHERE status='running'").get().n,
      invites: db.prepare('SELECT COUNT(*) n FROM targets WHERE connection_requested_at IS NOT NULL').get().n,
      ledger: db.prepare('SELECT COUNT(*) n FROM step_side_effects').get().n,
    };`);
  // ANCHOR: the logs table is the record every executed step writes to. If it is
  // empty the "no new activity" reading is meaningless.
  if (anchor("logs table is readable and non-empty", a.logs > 0, `${a.logs} rows, newest ${a.newest}`)) {
    const chromium = execFileSync("docker", ["exec", CONTAINER, "sh", "-c",
      "ps ax -o args= | grep -c '[c]hromium' || true"], { encoding: "utf8" }).trim();
    report("no chromium process is running", chromium === "0", `${chromium} processes`);
    report("no run is 'running'", a.running === 0, `${a.running} running`);
    console.log(`  info    logs=${a.logs} invites=${a.invites} ledger=${a.ledger} (compare to baseline)`);
  }
}

// ─── 6. container state ──────────────────────────────────────────────────────
console.log("\n[6] container");
{
  const out = execFileSync("docker", ["inspect", "-f",
    "{{.RestartCount}}|{{.State.Health.Status}}|{{.State.Health.FailingStreak}}|{{.State.StartedAt}}", CONTAINER],
    { encoding: "utf8" }).trim();
  const [rc, health, streak, started] = out.split("|");
  if (anchor("docker inspect returned state", out.includes("|"), out)) {
    report("RestartCount is 0", rc === "0", rc);
    report("health is healthy", health === "healthy", health);
    report("FailingStreak is 0", streak === "0", streak);
    console.log(`  info    started ${started}`);
  }
}

// ─── baseline snapshot / comparison ──────────────────────────────────────────
const bi = process.argv.indexOf("--save-baseline");
if (bi !== -1) {
  const snap = dbJson(`
    const t={}; for (const x of ['targets','runs','run_profiles','run_profile_tracks','logs','step_side_effects','workflows','workflow_steps'])
      t[x]=db.prepare('SELECT COUNT(*) n FROM "'+x+'"').get().n;
    return { counts:t, invites: db.prepare('SELECT full_name,connection_requested_at,degree,message_sent_at FROM targets WHERE connection_requested_at IS NOT NULL ORDER BY connection_requested_at').all() };`);
  writeFileSync(process.argv[bi + 1], JSON.stringify(snap, null, 2));
  console.log(`\nbaseline written to ${process.argv[bi + 1]}`);
}
const ci = process.argv.indexOf("--baseline");
if (ci !== -1) {
  console.log("\n[7] against baseline");
  const before = JSON.parse(readFileSync(process.argv[ci + 1], "utf8"));
  const now = dbJson(`
    const t={}; for (const x of ['targets','runs','run_profiles','run_profile_tracks','logs','step_side_effects','workflows','workflow_steps'])
      t[x]=db.prepare('SELECT COUNT(*) n FROM "'+x+'"').get().n;
    return { counts:t, invites: db.prepare('SELECT full_name,connection_requested_at,degree,message_sent_at FROM targets WHERE connection_requested_at IS NOT NULL ORDER BY connection_requested_at').all() };`);
  if (anchor("baseline has content", Object.keys(before.counts).length > 3, `${Object.keys(before.counts).length} tables`)) {
    for (const k of Object.keys(before.counts)) {
      report(`${k} count`, before.counts[k] === now.counts[k], `${before.counts[k]} -> ${now.counts[k]}`);
    }
    report("invitation rows identical",
      JSON.stringify(before.invites) === JSON.stringify(now.invites),
      `${now.invites.length} rows`);
  }
}

console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES: " + failures} (${checks} checks)`);
process.exit(failures === 0 ? 0 : 1);
