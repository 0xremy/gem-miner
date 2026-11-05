/**
 * Parses the proxy formats used in the wallet sheet:
 *
 *   domain:port::username:password   (double colon before the credentials)
 *   domain:port:username:password    (all single colons, as proxiesystem.net lists them)
 *
 * The credentials part is optional (`domain:port`), and a scheme may be given
 * in front of the host when the proxy is HTTPS (`https://domain:port::u:p`).
 */
export function parseProxy(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  let scheme = "http";
  let body = text;
  const schemeMatch = body.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    body = schemeMatch[2];
  }

  const separator = body.indexOf("::");
  let hostPort;
  let credentialPart = "";
  if (separator !== -1) {
    hostPort = body.slice(0, separator).trim();
    credentialPart = body.slice(separator + 2).trim();
  } else {
    // host:port:user:pass — only when the second segment is a port number, so
    // a password containing colons still lands in credentialPart.
    const quad = body.trim().match(/^([^\s:/]+:\d{1,5}):([^:\s]+):(.+)$/);
    if (quad) {
      hostPort = quad[1];
      credentialPart = `${quad[2]}:${quad[3]}`;
    } else {
      hostPort = body.trim();
    }
  }
  hostPort = hostPort.replace(/\/+$/, "");

  if (!/^[^\s:/]+:\d{1,5}$/.test(hostPort)) {
    throw new Error(
      `Unrecognised proxy "${text}" — expected domain:port::username:password or domain:port:username:password`,
    );
  }

  const colon = credentialPart.indexOf(":");
  const username = colon === -1 ? credentialPart : credentialPart.slice(0, colon);
  const password = colon === -1 ? "" : credentialPart.slice(colon + 1);

  const auth = username
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : "";

  return {
    raw: text,
    scheme,
    hostPort,
    username,
    password,
    url: `${scheme}://${auth}${hostPort}`,
    /** Safe to print: host:port only, never the credentials. */
    label: hostPort,
  };
}
