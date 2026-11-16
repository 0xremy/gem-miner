import { ProxyAgent } from "undici";

/**
 * Proxy formats used in the sheet (same as the miner and the token refresher):
 *
 *   domain:port::username:password
 *   domain:port:username:password
 *   socks5://username:password@domain:port   (standard URL form)
 *
 * Credentials are optional and a scheme may prefix the host: http, https,
 * socks5 or socks. socks5h is treated as socks5 — undici's SOCKS5 agent sends
 * the hostname to the proxy to resolve, so resolution is already remote.
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
  if (scheme === "socks5h") scheme = "socks5";

  const separator = body.indexOf("::");
  let hostPort;
  let credentialPart = "";
  const urlForm = schemeMatch ? body.match(/^([^@\s/]*)@([^\s/@]+:\d{1,5})\/?$/) : null;
  if (urlForm) {
    credentialPart = urlForm[1].trim();
    hostPort = urlForm[2];
  } else if (separator !== -1) {
    hostPort = body.slice(0, separator).trim();
    credentialPart = body.slice(separator + 2).trim();
  } else {
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
      `unrecognised proxy "${text}" — expected domain:port::username:password, domain:port:username:password or scheme://username:password@domain:port`,
    );
  }

  const colon = credentialPart.indexOf(":");
  const username = colon === -1 ? credentialPart : credentialPart.slice(0, colon);
  const password = colon === -1 ? "" : credentialPart.slice(colon + 1);
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";

  return {
    scheme,
    hostPort,
    url: `${scheme}://${auth}${hostPort}`,
    /** Safe to print: host:port only, never the credentials. */
    label: hostPort,
  };
}

const agents = new Map();

export function dispatcherFor(proxy) {
  if (!agents.has(proxy.url)) {
    agents.set(proxy.url, new ProxyAgent({ uri: proxy.url }));
  }
  return agents.get(proxy.url);
}
