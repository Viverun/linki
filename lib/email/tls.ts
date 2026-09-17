import { isIP } from "node:net";
import { checkServerIdentity, type ConnectionOptions } from "node:tls";

export const EMAIL_TLS_REJECT_UNAUTHORIZED = true;

export function emailTlsOptions(host: string): ConnectionOptions {
  return {
    rejectUnauthorized: EMAIL_TLS_REJECT_UNAUTHORIZED,
    ...(isIP(host) ? {} : { servername: host }),
    checkServerIdentity: (_servername, cert) => checkServerIdentity(host, cert),
  };
}
