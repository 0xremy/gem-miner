import { request } from "../http.js";
import { STRATEGY } from "../mines.js";

/**
 * Feature 2 — arm one vein of a mine.
 *
 *   POST /api/mining/positions
 *   body: { locationId, spotId, strategy, gear? }
 *
 * A position is tied to a single vein (`spotId`) and a strategy; the old
 * `{ locationId }`-only body is no longer enough.
 */
export async function miningPositions(
  wallet,
  { locationId, spotId, strategy = STRATEGY, gear, verbose = true } = {},
) {
  if (!spotId) throw new Error("miningPositions needs the vein's spotId");
  const payload = { locationId, spotId, strategy };
  if (gear) payload.gear = gear;
  return request({
    method: "POST",
    path: "/api/mining/positions",
    payload,
    wallet,
    verbose,
  });
}
