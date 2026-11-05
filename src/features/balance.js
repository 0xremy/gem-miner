import { request } from "../http.js";

/**
 * Feature 4 — the wallet's current balance.
 *
 *   GET /user/balance
 *   → { gems, energy, miningPower, level, energyCapacity, miningSpeed, multiplier, miningMultiplier }
 *
 * This is the only cheap way to read energy: claim/start responses are the
 * other place it appears.
 */
export async function userBalance(wallet, { verbose = true } = {}) {
  return request({ method: "GET", path: "/user/balance", wallet, verbose });
}
