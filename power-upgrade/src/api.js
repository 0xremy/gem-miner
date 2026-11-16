import { fetch as undiciFetch } from "undici";
import { config } from "./config.js";
import { dispatcherFor } from "./proxy.js";

/**
 * One request as the game frontend makes it: the wallet's JWT in
 * `authorization`, its address in `x-wallet-address`, and the request leaving
 * through that wallet's own proxy IP.
 */

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const RETRY_STATUS = new Set([429, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoff = (attempt) => Math.min(8000, 900 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);

export function createClient({ token, address, proxy }) {
  const via = proxy ? ` (via proxy ${proxy.label})` : "";

  async function request({ method = "POST", path, body }) {
    const url = new URL(config.baseUrl + path);
    const init = {
      method,
      headers: {
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-wallet-address": address,
        referer: "https://gem.bullshot.io/",
        origin: "https://gem.bullshot.io",
        "user-agent": process.env.GEM_USER_AGENT || DEFAULT_USER_AGENT,
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (proxy) init.dispatcher = dispatcherFor(proxy);

    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await undiciFetch(url, init);
      } catch (error) {
        const cause = error.cause?.code || error.cause?.message;
        if (attempt > config.retries) {
          const hint =
            proxy && /cancel|socket|ECONN/i.test(String(cause))
              ? " (proxy refused the tunnel — check that row's Proxy value)"
              : "";
          throw new Error(`${method} ${path} failed${cause ? `: ${cause}` : ""}${via}${hint}`);
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

      const message = typeof body === "object" && body?.message ? `: ${body.message}` : "";
      const error = new Error(`${method} ${path} → ${response.status}${message}${via}`);
      error.status = response.status;
      error.body = body;

      if (!RETRY_STATUS.has(response.status) || attempt > config.retries) throw error;

      const after = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(10_000, after * 1000) : backoff(attempt));
    }
  }

  return {
    /** { gems, energy, miningPower, level, energyCapacity, miningSpeed, … } */
    balance: () => request({ method: "GET", path: "/api/user/balance" }),
    /** Buys one flat upgrade; the response carries the updated `user`. */
    buyPower: () => request({ method: "POST", path: `/api/upgrades/${config.upgradeId}` }),
    /** Buys one Energy Capacity upgrade; `{ success, message, upgrade, user }`. */
    buyEnergy: () => request({ method: "POST", path: `/api/upgrades/${config.energyUpgradeId}` }),
    /** The shop catalog: id, name, price, effect, … Public, no auth needed. */
    catalog: () => request({ method: "GET", path: "/api/shop/items" }),
    /** Buys one of a shop item; `{ success, item, user, inventory }`. */
    purchase: (itemId) =>
      request({ method: "POST", path: "/api/shop/purchase", body: { itemId } }),
    /** { daily: [], weekly: [], oneTime: [], resets: { … } } — what is claimable. */
    quests: () => request({ method: "GET", path: "/api/quests" }),
    /** Arms a quest for its `delaySeconds`; the reward is collected with claim. */
    startQuest: (questId) =>
      request({ method: "POST", path: "/api/quests/start", body: { questId } }),
    /** Collects a started quest; `{ success, message, reward: { gems, xp }, user }`. */
    claimQuest: (questId, tweetUrl = "") =>
      request({ method: "POST", path: "/api/quests/claim", body: { questId, tweetUrl } }),

    /** The six mines with their quick/standard/deep costs and durations. */
    locations: () => request({ method: "GET", path: "/api/mining/locations" }),
    /** One mine's vein grid: `{ seed, refreshesAt, spots: [{ id, index, vein, occupied, … }] }`. */
    spots: (locationId) =>
      request({
        method: "GET",
        path: `/api/mining/locations/${encodeURIComponent(locationId)}/spots`,
      }),
    /** Every unclaimed position of the wallet (finished and still digging). */
    positions: () => request({ method: "GET", path: "/api/mining/positions" }),
    /** Arms one vein; the position pays out when its duration has elapsed. */
    startPosition: ({ locationId, spotId, strategy = "deep", gear } = {}) => {
      const body = { locationId, spotId, strategy };
      if (gear) body.gear = gear;
      return request({ method: "POST", path: "/api/mining/positions", body });
    },
    /** Collects a finished vein; `{ status, gemsEarned, rewards, user }`. */
    claimPosition: (positionId) =>
      request({
        method: "POST",
        path: `/api/mining/positions/${encodeURIComponent(positionId)}/claim`,
      }),
  };
}
