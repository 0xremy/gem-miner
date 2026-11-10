import { ProxyAgent, fetch as proxyFetch } from "undici";
import { config } from "./config.js";

/**
 * The game API sits behind Cloudflare, which rejects the bare "undici"/"node"
 * user agents with a 403 HTML page. Send the browser string the frontend sends;
 * GEM_USER_AGENT overrides it if the check ever tightens again.
 */
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** One reusable ProxyAgent per proxy URL, so wallets do not build a tunnel per request. */
const proxyAgents = new Map();
function dispatcherFor(proxy) {
  if (!proxyAgents.has(proxy.url)) {
    proxyAgents.set(proxy.url, new ProxyAgent({ uri: proxy.url }));
  }
  return proxyAgents.get(proxy.url);
}

/**
 * Sends one request and prints the three things every feature is built from:
 * the request, the payload, and the response.
 *
 * @param {object} options
 * @param {string} options.method
 * @param {string} options.path        e.g. "/api/mining/positions"
 * @param {object} [options.payload]   sent as the JSON body
 * @param {object} [options.query]     appended as a query string
 * @param {object} [options.headers]   merged over the defaults
 * @param {boolean} [options.verbose]  print the request/payload/response blocks
 * @param {object} [options.wallet]    { label, walletAddress, token, proxy } to act as; defaults to .env
 */
export async function request({
  method = "POST",
  path,
  payload,
  query,
  headers = {},
  verbose = true,
  wallet,
}) {
  const token = wallet?.token ?? config.token;
  const walletAddress = wallet?.walletAddress ?? config.walletAddress;
  const url = new URL(config.baseUrl + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const body = payload === undefined ? undefined : JSON.stringify(payload);

  const finalHeaders = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    authorization: token ? `Bearer ${token}` : undefined,
    "x-wallet-address": walletAddress || undefined,
    Referer: "https://gem.bullshot.io/",
    "user-agent": process.env.GEM_USER_AGENT || DEFAULT_USER_AGENT,
    ...headers,
  };
  for (const key of Object.keys(finalHeaders)) {
    if (finalHeaders[key] === undefined) delete finalHeaders[key];
  }

  if (verbose) {
    console.log(`\n── REQUEST ─────────────────────────────────────────`);
    if (wallet?.label) console.log(`wallet: ${wallet.label} (${walletAddress})`);
    if (wallet?.proxy) console.log(`proxy: ${wallet.proxy.label}`);
    console.log(`${method} ${url.toString()}`);
    for (const [key, value] of Object.entries(finalHeaders)) {
      const shown =
        key === "authorization" && value.length > 24
          ? `${value.slice(0, 16)}…${value.slice(-6)}`
          : value;
      console.log(`  ${key}: ${shown}`);
    }

    console.log(`\n── PAYLOAD ─────────────────────────────────────────`);
    console.log(body === undefined ? "(no body)" : body);
  }

  const startedAt = Date.now();
  let response;
  try {
    response = wallet?.proxy
      ? await proxyFetch(url, {
          method,
          headers: finalHeaders,
          body,
          dispatcher: dispatcherFor(wallet.proxy),
        })
      : await fetch(url, { method, headers: finalHeaders, body });
  } catch (error) {
    if (wallet?.proxy) {
      const cause = error.cause?.code || error.cause?.message;
      error.message = `${error.message}${cause ? ` ${cause}` : ""} (via proxy ${wallet.proxy.label})`;
    }
    throw error;
  }
  const elapsedMs = Date.now() - startedAt;
  const text = await response.text();

  let parsed = text;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    // Not JSON: keep the raw text.
  }

  if (verbose) {
    console.log(`\n── RESPONSE ────────────────────────────────────────`);
    console.log(`${response.status} ${response.statusText} (${elapsedMs} ms)`);
    console.log(
      typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2),
    );
  }

  if (!response.ok) {
    const error = new Error(`${method} ${path} failed with ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }

  return { status: response.status, headers: response.headers, body: parsed };
}
