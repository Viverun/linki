import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extras = ["scripts/c0-verify.mjs", "scripts/c0-check.mjs", "scripts/c0.Dockerfile", "docs/production-readiness.md", ".github/workflows/c0.yml", ".node-version"];
// Agent/tooling directories are never application source: skip them whether tracked
// (e.g. `.agents/skills/`) or not. Everything else that is unsafe still throws for
// tracked paths so a tracked secret or database is loud, not silently dropped.
const isTooling = (p) => p.split("/").some(part => [".agents", ".opencode", ".claude"].includes(part));
const isUnsafe = (p) => isTooling(p) || p.startsWith("/") || p.split("/").some(part => ["..", ".git", "node_modules", ".next", "data"].includes(part)) || /(^|\/)\.env(?!\.example$)|\.(db(?:-wal|-shm)?|pem|key)$/.test(p);
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).filter(p => !isTooling(p));
const untracked = execFileSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).filter(p => !isUnsafe(p));
const candidates = [...new Set([...tracked, ...untracked, ...extras])].sort();
const output = mkdtempSync(join(tmpdir(), "linki-c0-"));
const context = join(output, "context");
mkdirSync(join(context, "source"), { recursive: true });
const manifest = [];
for (const path of candidates) {
  if (isUnsafe(path)) throw new Error(`Unsafe snapshot path: ${path}`);
  const source = join(root, path);
  if (!existsSync(source)) {
    if (extras.includes(path)) throw new Error(`Missing required extra file: ${path}`);
    continue;
  }
  if (!lstatSync(source).isFile()) throw new Error(`Snapshot requires a regular file: ${path}`);
  const destination = join(context, "source", path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  manifest.push({ path, sha256: createHash("sha256").update(readFileSync(source)).digest("hex") });
}
for (const file of ["package.json", "package-lock.json"]) copyFileSync(join(root, file), join(context, file));
copyFileSync(join(root, "scripts/c0.Dockerfile"), join(context, "Dockerfile"));
const identity = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  snapshotSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  manifest,
};
writeFileSync(join(output, "manifest.json"), JSON.stringify(identity, null, 2));
console.log(`C0 evidence: ${output}`);
console.log(`C0 snapshot: ${identity.snapshotSha256} (${manifest.length} files; current tracked contents plus explicit C0 additions)`);
const name = `linki-c0-${randomUUID()}`;
function run(label, args, timeout) {
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(join(output, `${label}.log`), log);
  process.stdout.write(log);
  if (result.error) console.error(result.error.message);
  return result;
}
try {
  const build = run("prepare", ["build", "--tag", name, context], 900000);
  if (build.status !== 0) throw new Error("Verification image preparation failed; checks not run");
  const image = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", name], { encoding: "utf8" }).trim();
  writeFileSync(join(output, "image-id.txt"), `${image}\n`);
  const checked = run("checks", ["run", "--name", name, "--pull=never", "--init", "--network=none", "--read-only", "--user=1000:1000", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--pids-limit=512", "--memory=6g", "--cpus=2", "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g,mode=1777", "--tmpfs", "/work:rw,nosuid,nodev,exec,size=3g,mode=1777", image], 900000);
  process.exitCode = checked.status === 0 ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
  // Image intentionally retained for focused single-test reruns; cleanup is manual.
  console.log(`C0 evidence retained at ${output}; image ${name} retained; no production mounts used`);
}
