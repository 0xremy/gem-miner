import { request } from "../http.js";

/**
 * Feature 1 — start a mining session at a location.
 *
 *   POST /api/mining/positions
 *   body: { "locationId": "ember-mine" }
 */
export async function miningPositions(wallet, { locationId = "ember-mine", verbose = true } = {}) {
  return request({
    method: "POST",
    path: "/api/mining/positions",
    payload: { locationId },
    wallet,
    verbose,
  });
}
