import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "linki-mail-tls-"));
const root = resolve(import.meta.dirname, "..");
const file = (name: string) => join(directory, name);
const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "pipe", timeout: 10_000 });

before(() => {
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Linki synthetic mail CA", "-addext", "basicConstraints=critical,CA:TRUE");
  openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost");
  writeFileSync(file("index"), "");
  writeFileSync(file("serial"), "01\n");
  writeFileSync(file("ca.cnf"), [
    "[ca]", "default_ca=fixture", "[fixture]", "database=index", "serial=serial", "new_certs_dir=.",
    "certificate=ca.pem", "private_key=ca.key", "default_md=sha256", "policy=policy", "unique_subject=no",
    "[policy]", "commonName=supplied", "[server]", "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth",
    "subjectAltName=DNS:localhost,IP:127.0.0.1", "[mismatched]", "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth",
    "subjectAltName=DNS:other.fixture.test,IP:127.0.0.2", "",
  ].join("\n"));
  for (const name of ["trusted", "expired", "mismatched"]) {
    openssl("ca", "-batch", "-notext", "-config", "ca.cnf", "-in", "server.csr", "-out", `${name}.pem`,
      "-extensions", name === "mismatched" ? "mismatched" : "server", "-startdate", "20000101000000Z",
      "-enddate", name === "expired" ? "20010101000000Z" : "20990101000000Z");
  }
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "untrusted.key", "-out", "untrusted.pem", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1");
});

after(() => rmSync(directory, { recursive: true, force: true }));

function run(mode: string, certificate: string, expected = certificate, extraEnv: Record<string, string> = {}) {
  const fixture = new URL("./support/mail-tls-fixture.ts", import.meta.url).href;
  const args = [mode, file(`${certificate}.pem`), file(certificate === "untrusted" ? "untrusted.key" : "server.key"), expected];
  execFileSync(process.execPath, [
    "--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--import", join(root, "scripts/test-setup.mjs"), "--input-type=module", "--eval",
    `import { runMailTlsFixture } from ${JSON.stringify(fixture)}; await runMailTlsFixture(...${JSON.stringify(args)});`,
  ], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, NODE_ENV: "test", NODE_EXTRA_CA_CERTS: file("ca.pem"), ...extraEnv },
    timeout: 20_000,
    stdio: "pipe",
  });
}

for (const mode of ["smtp-tls", "smtp-starttls", "smtp-verify-tls", "smtp-verify-starttls", "imap"]) {
  for (const certificate of ["trusted", "untrusted", "expired", "mismatched"]) {
    test(`${mode}: ${certificate} certificate ${certificate === "trusted" ? "works with NODE_EXTRA_CA_CERTS" : "fails before authentication or mail"}`, { timeout: 25_000 }, () => {
      run(mode, certificate);
    });
  }
}

for (const mode of ["smtp-no-starttls", "smtp-reject-starttls", "smtp-verify-no-starttls", "smtp-verify-reject-starttls"]) {
  test(`${mode}: TLS unavailable fails without plaintext credentials or mail`, { timeout: 25_000 }, () => {
    run(mode, "trusted", "unavailable");
  });
}

for (const mode of ["smtp-tls", "smtp-starttls", "imap"]) {
  test(`${mode}: global TLS disable cannot override email verification`, { timeout: 25_000 }, () => {
    run(mode, "untrusted", "untrusted", { NODE_TLS_REJECT_UNAUTHORIZED: "0" });
  });
}

test("all mail transport call sites bind TLS to their configured host and SMTP requires TLS", () => {
  const sender = readFileSync(join(root, "lib/email/sender.ts"), "utf8");
  assert.equal((sender.match(/requireTLS: true/g) ?? []).length, 2);
  assert.equal((sender.match(/tls: emailTlsOptions\(account\.smtp_host\)/g) ?? []).length, 2);
  assert.match(sender, /tlsOptions: emailTlsOptions\(account\.imap_host\)/);
  for (const [path, host] of [
    ["lib/email/inbox.ts", "account.imap_host!"],
    ["pages/api/inbox/thread.ts", "cfg.host"],
    ["pages/api/targets/[id]/emails.ts", "cfg.host"],
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.ok(source.includes(`tlsOptions: emailTlsOptions(${host})`), path);
    assert.match(source, /tls: true/);
  }
});
