import test from "node:test";
import assert from "node:assert/strict";
import { checkServerIdentity } from "node:tls";
import Imap from "imap";
import { emailTlsOptions } from "@/lib/email/tls";

test("IMAP configuration requires certificate verification and binds the mail hostname", () => {
  const imap = new Imap({
    host: "mail.fixture.test",
    user: "fixture",
    password: "fixture",
    tls: true,
    tlsOptions: emailTlsOptions("mail.fixture.test"),
  });
  const config = (imap as unknown as { _config: { tlsOptions: ReturnType<typeof emailTlsOptions> } })._config;
  assert.equal(config.tlsOptions.rejectUnauthorized, true);
  assert.equal(config.tlsOptions.servername, "mail.fixture.test");
  assert.equal(typeof config.tlsOptions.checkServerIdentity, "function");
});

test("email TLS identity is bound to the configured hostname, not the socket hostname", () => {
  const options = emailTlsOptions("mail.fixture.test");
  const cert = { subjectaltname: "DNS:other.fixture.test" } as Parameters<typeof checkServerIdentity>[1];
  assert.equal((options.checkServerIdentity?.("other.fixture.test", cert) as NodeJS.ErrnoException)?.code, "ERR_TLS_CERT_ALTNAME_INVALID");
});

test("IP destinations verify IP SANs without sending an IP SNI value", () => {
  const options = emailTlsOptions("127.0.0.1");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.servername, undefined);
  const cert = { subjectaltname: "IP Address:127.0.0.1" } as Parameters<typeof checkServerIdentity>[1];
  assert.equal(options.checkServerIdentity?.("localhost", cert), undefined);
  const wrongCert = { subjectaltname: "IP Address:127.0.0.2" } as Parameters<typeof checkServerIdentity>[1];
  assert.equal((options.checkServerIdentity?.("127.0.0.2", wrongCert) as NodeJS.ErrnoException)?.code, "ERR_TLS_CERT_ALTNAME_INVALID");
});
