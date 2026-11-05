import { request } from "../http.js";

/**
 * Feature 2 — list every mining position (session) for the wallet.
 *
 *   GET /api/mining/positions
 *   no payload; the response is a bare array (no status/user envelope)
 */
export async function listMiningPositions(wallet, { verbose = true } = {}) {
  return request({
    method: "GET",
    path: "/api/mining/positions",
    wallet,
    verbose,
  });
}
