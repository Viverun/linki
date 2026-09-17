import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as createTcpServer, type Socket } from "node:net";
import { createServer as createTlsServer, createSecureContext, TLSSocket } from "node:tls";
import { sendEmail, testImapConnection, testSmtpConnection } from "../../lib/email/sender";

export async function runMailTlsFixture(mode: string, certPath: string, keyPath: string, expected: string) {
  const credentials = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  const sockets = new Set<Socket>();
  const commands: Array<{ line: string; encrypted: boolean }> = [];
  let messages = 0;
  let encryptedConnections = 0;
  const isImap = mode === "imap";
  const implicit = mode === "smtp-tls" || mode === "smtp-verify-tls" || isImap;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  };
  const receive = (socket: Socket, encrypted: boolean, greeting: boolean) => {
    track(socket);
    if (encrypted) encryptedConnections++;
    if (greeting) socket.write(isImap ? "* OK fixture ready\r\n" : "220 fixture ESMTP\r\n");
    let buffer = "";
    let data = false;
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") {
            data = false;
            messages++;
            socket.write("250 accepted\r\n");
          }
          continue;
        }
        commands.push({ line, encrypted });
        if (isImap) {
          const [tag, command] = line.split(" ");
          if (command === "CAPABILITY") socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK capability\r\n`);
          else if (command === "LOGIN") socket.write(`${tag} OK logged in\r\n`);
          else if (command === "LIST") socket.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK list\r\n`);
          else if (command === "LOGOUT") socket.end(`* BYE\r\n${tag} OK logout\r\n`);
          else socket.write(`${tag} BAD unsupported\r\n`);
        } else if (/^(EHLO|HELO) /.test(line)) {
          const starttls = !encrypted && !mode.endsWith("no-starttls") ? "250-STARTTLS\r\n" : "";
          socket.write(`250-fixture\r\n${starttls}250 AUTH PLAIN\r\n`);
        } else if (line === "STARTTLS") {
          if (mode.endsWith("no-starttls") || mode.endsWith("reject-starttls")) {
            socket.write("454 TLS unavailable\r\n");
          } else {
            socket.removeListener("data", onData);
            socket.write("220 upgrade\r\n");
            const tlsSocket = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext(credentials) });
            receive(tlsSocket, true, false);
            return;
          }
        } else if (line.startsWith("AUTH ")) socket.write("235 authenticated\r\n");
        else if (line.startsWith("MAIL FROM:") || line.startsWith("RCPT TO:")) socket.write("250 ok\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 send data\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("500 unsupported\r\n");
      }
    };
    socket.on("data", onData);
  };
  const server = implicit
    ? createTlsServer(credentials, socket => receive(socket, true, true))
    : createTcpServer(socket => receive(socket, false, true));
  server.on("connection", track);
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const account = {
      id: "fixture",
      from_email: "sender@fixture.test",
      from_name: null,
      smtp_host: "127.0.0.1",
      smtp_port: address.port,
      smtp_secure: implicit ? 1 : 0,
      username: "synthetic-user",
      password: "synthetic-password",
    };
    let error: string | null = null;
    if (isImap) {
      error = await testImapConnection({
        imap_host: "127.0.0.1",
        imap_port: address.port,
        username: account.username,
        password: account.password,
        imap_username: null,
        imap_password: null,
      });
    } else if (mode.startsWith("smtp-verify")) {
      error = await testSmtpConnection(account);
    } else {
      try {
        await sendEmail(account, "recipient@fixture.test", "Synthetic TLS test", "Synthetic body");
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    if (expected === "trusted") {
      assert.equal(error, null);
      assert.ok(encryptedConnections > 0);
      assert.ok(commands.some(({ line, encrypted }) => encrypted && /(?:^AUTH | LOGIN )/.test(line)));
      if (!isImap && !mode.startsWith("smtp-verify")) assert.equal(messages, 1);
    } else {
      assert.ok(error, "invalid TLS must fail");
      const errors: Record<string, RegExp> = {
        untrusted: /self.signed|unable to verify|unable to get local issuer/i,
        expired: /expired/i,
        mismatched: /altname|not in the cert|IP address mismatch/i,
        unavailable: /STARTTLS|TLS unavailable/i,
      };
      assert.match(error, errors[expected]);
      assert.equal(messages, 0);
      assert.equal(commands.filter(({ line }) => /(?:^AUTH | LOGIN |^MAIL FROM:|^DATA$)/.test(line)).length, 0);
    }
    assert.equal(commands.filter(({ line, encrypted }) => !encrypted && /(?:^AUTH | LOGIN |^MAIL FROM:|^DATA$)/.test(line)).length, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
