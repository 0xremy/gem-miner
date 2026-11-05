import { request } from "../http.js";

/**
 * Feature 3 — claim the reward of a finished mining position.
 *
 *   POST /api/mining/positions/:id/claim
 *   no payload
 */
export async function claimPosition(wallet, positionId, { verbose = true } = {}) {
  if (!positionId) throw new Error("claimPosition needs a position id");
  return request({
    method: "POST",
    path: `/api/mining/positions/${encodeURIComponent(positionId)}/claim`,
    wallet,
    verbose,
  });
}

/** A position can be claimed once its window has elapsed and it is not already claimed. */
export function isClaimable(position) {
  if (position.status === "claimed") return false;
  if (typeof position.remainingSeconds === "number" && position.remainingSeconds > 0) return false;
  if (["completed", "ready", "claimable"].includes(position.status)) return true;
  return position.status === "active" && position.remainingSeconds <= 0;
}
