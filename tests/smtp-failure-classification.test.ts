import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import nodemailer from "nodemailer";

const { classifySmtpFailure } = await import("@/lib/email/sender");

type Shape = { code?: string; command?: string; responseCode?: number; message?: string };
function smtpError(shape: Shape): Error {
  const err = new Error(shape.message ?? "synthetic") as Error & Shape;
  if (shape.code) err.code = shape.code;
  if (shape.command) err.command = shape.command;
  if (shape.responseCode !== undefined) err.responseCode = shape.responseCode;
  return err;
}

const cases: Array<[string, Shape | unknown, "pre_send" | "rejected" | "ambiguous"]> = [
  ["connection refused", smtpError({ code: "ECONNECTION", command: "CONN" }), "pre_send"],
  ["EHLO failure", smtpError({ code: "EPROTOCOL", command: "EHLO", responseCode: 500 }), "pre_send"],
  ["STARTTLS unavailable", smtpError({ code: "ETLS", command: "STARTTLS" }), "pre_send"],
  ["auth rejected", smtpError({ code: "EAUTH", command: "AUTH", responseCode: 535 }), "pre_send"],
  ["sender rejected", smtpError({ code: "EENVELOPE", command: "MAIL FROM", responseCode: 550 }), "pre_send"],
  ["recipient rejected", smtpError({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }), "pre_send"],
  ["API-level envelope error", smtpError({ code: "EENVELOPE", command: "API" }), "pre_send"],
  ["TLS identity mismatch (our policy)", Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "pre_send"],
  ["self-signed (our policy)", Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "pre_send"],
  ["expired cert (our policy)", Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }), "pre_send"],
  ["DATA command refused (354 never came)", smtpError({ code: "EENVELOPE", command: "DATA", responseCode: 451 }), "rejected"],
  ["body refused after final dot", smtpError({ code: "EMESSAGE", command: "DATA", responseCode: 554 }), "rejected"],
  ["timeout during DATA", smtpError({ code: "ETIMEDOUT", command: "DATA" }), "ambiguous"],
  ["socket died during DATA", smtpError({ code: "ESOCKET", command: "DATA" }), "ambiguous"],
  ["connection closed during DATA", smtpError({ code: "ECONNECTION", command: "DATA" }), "ambiguous"],
  ["no metadata at all", new Error("something odd"), "ambiguous"],
  ["non-Error throw", "a string", "ambiguous"],
  ["undefined", undefined, "ambiguous"],
];

for (const [name, err, expected] of cases) {
  test(`classifySmtpFailure: ${name} → ${expected}`, () => {
    assert.equal(classifySmtpFailure(err), expected);
  });
}

// ─── live nodemailer errors from a loopback SMTP fake ───────────────────────
// Drives nodemailer's real transport (TLS policy bypassed on purpose: this test
// is about transport error SHAPES, tests/email-tls*.test.ts own the TLS policy).

type Behaviour = "drop-after-data" | "reject-body";

async function withFakeSmtp(behaviour: Behaviour, fn: (port: number) => Promise<void>) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.write("220 fake ESMTP\r\n");
    let buffer = ""; let inData = false;
    socket.on("data", chunk => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (inData) {
          if (line !== ".") continue;
          inData = false;
          if (behaviour === "drop-after-data") { socket.destroy(); return; }
          socket.write("554 5.7.1 message rejected by policy\r\n");
          continue;
        }
        if (/^(EHLO|HELO) /.test(line)) socket.write("250-fake\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH ")) socket.write("235 ok\r\n");
        else if (line.startsWith("MAIL FROM:") || line.startsWith("RCPT TO:")) socket.write("250 ok\r\n");
        else if (line === "DATA") { inData = true; socket.write("354 go\r\n"); }
        else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("500 unsupported\r\n");
      }
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await fn(address.port);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>(r => server.close(() => r()));
  }
}

async function sendViaFake(port: number): Promise<unknown> {
  const transporter = nodemailer.createTransport({
    host: "127.0.0.1", port, secure: false, ignoreTLS: true,
    auth: { user: "u", pass: "p" }, connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 3000,
  });
  try {
    await transporter.sendMail({ from: "a@fake.test", to: "b@fake.test", subject: "s", text: "t" });
    return null;
  } catch (err) { return err; }
}

test("live: socket dropped after DATA is ambiguous", async () => {
  await withFakeSmtp("drop-after-data", async port => {
    const err = await sendViaFake(port);
    assert.ok(err instanceof Error);
    assert.equal(classifySmtpFailure(err), "ambiguous");
  });
});

test("live: 554 after the body is rejected, not ambiguous", async () => {
  await withFakeSmtp("reject-body", async port => {
    const err = await sendViaFake(port);
    assert.ok(err instanceof Error);
    assert.equal((err as Error & { responseCode?: number }).responseCode, 554);
    assert.equal(classifySmtpFailure(err), "rejected");
  });
});
