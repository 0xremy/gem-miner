import { fetch as undiciFetch } from "undici";
import { config } from "./config.js";
import { dispatcherFor } from "./proxy.js";

/**
 * The game has no refresh endpoint. A token is only ever minted by signing a
 * nonce with the wallet key, so "refreshing" means logging in again:
 *
 *   POST /api/auth/nonce  { walletAddress }              → { nonce, message }
 *   sign message with the wallet                          → signature (client side)
 *   POST /api/auth/login  { walletAddress, signature, message } → { token }
 *
 * The token is a JWT with a 72-hour lifetime.
 */

/**
 * Cloudflare rejects the bare "undici"/"node" user agent with a 403 HTML page,
 * so every call sends the browser string the game frontend sends.
 */
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Throttled / transient statuses worth another try through the same proxy. */
const RETRY_STATUS = new Set([429, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter: ~0.9s, 1.8s, 3.6s. */
const backoff = (attempt) => Math.min(8000, 900 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);

/**
 * One POST to the game API, optionally tunnelled through a proxy so the request
 * leaves from that wallet's own IP. Cloudflare rate-limits per IP, which is why
 * a few hundred logins from one address end in 429s.
 */
async function post(path, payload, { proxy } = {}) {
  const url = new URL(config.baseUrl + path);
  const init = {
    method: "POST",
    headers: {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      "content-type": "application/json",
      referer: "https://gem.bullshot.io/",
      origin: "https://gem.bullshot.io",
      "user-agent": process.env.GEM_USER_AGENT || DEFAULT_USER_AGENT,
    },
    body: JSON.stringify(payload),
  };
  if (proxy) init.dispatcher = dispatcherFor(proxy);
  const via = proxy ? ` (via proxy ${proxy.label})` : "";

  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await undiciFetch(url, init);
    } catch (error) {
      const cause = error.cause?.code || error.cause?.message;
      if (attempt > config.authRetries) {
        // undici reports a refused CONNECT as a bare cancellation, which says
        // nothing about the sheet cell that caused it.
        const hint =
          proxy && /cancel|socket|ECONN/i.test(String(cause))
            ? " (proxy refused the tunnel — check that row's Proxy value)"
            : "";
        throw new Error(`POST ${path} failed${cause ? `: ${cause}` : ""}${via}${hint}`);
      }
      await sleep(backoff(attempt));
      continue;
    }

    const text = await response.text();
    let body = text;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // Not JSON — usually a Cloudflare interstitial.
    }

    if (response.ok) return body;

    const cloudflare = typeof body === "string" && /\bcloudflare\b/i.test(body);
    const detail =
      typeof body === "string"
        ? `${body.slice(0, 120).replace(/\s+/g, " ")}…${cloudflare ? ` (Cloudflare block via ${proxy ? proxy.label : "this IP"})` : ""}`
        : JSON.stringify(body);
    const error = new Error(`POST ${path} → ${response.status} ${response.statusText}: ${detail}${via}`);
    error.status = response.status;

    if (!RETRY_STATUS.has(response.status) || attempt > config.authRetries) throw error;

    // Honour a short Retry-After, otherwise back off ourselves.
    const after = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(10_000, after * 1000) : backoff(attempt));
  }
}

/** Returns a fresh JWT for the wallet behind `signer`. */
export async function refreshToken({ address, signer, proxy }) {
  const nonce = await post("/api/auth/nonce", { walletAddress: address }, { proxy });
  const message = nonce?.message || `Sign in to Bull GEM on Base: ${nonce?.nonce}`;
  if (!message || message.endsWith("undefined")) {
    throw new Error("the nonce endpoint returned no signable message");
  }

  // personal_sign (EIP-191) over the exact string the server handed us.
  const signature = await signer.signMessage(message);

  const login = await post(
    "/api/auth/login",
    { walletAddress: address, signature, message },
    { proxy },
  );

  if (!login?.token) throw new Error("login succeeded but returned no token");
  return login.token;
}

/** Reads the `exp` claim (ms) out of a JWT without verifying it. */
export function tokenExpiry(token) {
  try {
    const [, payload] = token.split(".");
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}
