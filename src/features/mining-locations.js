import { request } from "../http.js";
import { STRATEGY, costOf } from "../mines.js";

/**
 * Feature 1 — the mine catalog and each mine's vein grid.
 *
 *   GET /api/mining/locations             → [{ id, name, miningPowerRequired, strategies }]
 *   GET /api/mining/locations/:id/spots   → { seed, refreshesAt, spots: [{ id, index, vein, occupied }] }
 *
 * The catalog says what a vein costs and how long it runs; the spots say which
 * veins are free. Both are per wallet only in the `occupied` flag.
 */
export async function listMiningLocations(wallet, { verbose = false } = {}) {
  return request({ method: "GET", path: "/api/mining/locations", wallet, verbose });
}

export async function listMiningSpots(wallet, locationId, { verbose = false } = {}) {
  if (!locationId) throw new Error("listMiningSpots needs a location id");
  return request({
    method: "GET",
    path: `/api/mining/locations/${encodeURIComponent(locationId)}/spots`,
    wallet,
    verbose,
  });
}

/**
 * Deep cost/power/duration per mine id. Wallet-independent, so it is fetched
 * once per process; a failed fetch is retried by the next wallet.
 */
let catalogPromise = null;

export function deepCatalog(wallet) {
  if (!catalogPromise) {
    catalogPromise = listMiningLocations(wallet).then(({ body }) => {
      const list = Array.isArray(body) ? body : (body?.locations ?? []);
      const map = new Map();
      for (const mine of list) {
        const deep = (mine.strategies ?? []).find((strategy) => strategy.id === STRATEGY);
        map.set(mine.id, {
          id: mine.id,
          name: mine.name ?? mine.id,
          powerRequired: Number(mine.miningPowerRequired ?? mine.powerRequired ?? 0),
          cost: Number(deep?.energyCost ?? mine.energyCost ?? costOf(mine.id)),
          seconds: Number(deep?.durationSeconds ?? mine.durationSeconds ?? 0),
        });
      }
      return map;
    });
    catalogPromise.catch(() => {
      catalogPromise = null;
    });
  }
  return catalogPromise;
}
