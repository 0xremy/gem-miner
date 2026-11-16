import { isClaimable } from "./features/mining-claim.js";
import { miningPositions } from "./features/mining-positions.js";
import { listMiningSpots } from "./features/mining-locations.js";
import { MINES, STRATEGY, VEINS_PER_MINE, costOf, describeMine, rankOf } from "./mines.js";

/**
 * The mining loop for one wallet, as the game plays it now.
 *
 *   1. every vein of the wallet's Location mine gets the "deep" strategy, until
 *      all six are digging or the energy runs out
 *   2. only when all six are digging, lower-rank mines are filled with whatever
 *      energy is left — never a higher rank
 *   3. a mine that still has idle veins is left alone until the next pass
 *
 * Claims happen in the runner before this runs, so their energy is not counted
 * twice. `catalog` comes from features/mining-locations.js and is what makes the
 * cost/power checks match the live game.
 *
 * @returns {Promise<{
 *   mine: string, started: number, veins: number, total: number,
 *   spill: Array<{ mine: string, started: number }>,
 *   complete: boolean, outOfEnergy: boolean, energy: number, notes: string[],
 * }>}
 */
export async function digVeins(
  wallet,
  { mine, gear = null, energy = 0, power = 0, positions = [], catalog = null },
) {
  // Veins this wallet is already digging; claimed ones are free again.
  const busy = new Set(
    positions
      .filter((position) => position.spotId && !isClaimable(position))
      .map((position) => position.spotId),
  );

  let left = Number(energy) || 0;
  const record = {
    mine,
    started: 0,
    veins: 0,
    total: VEINS_PER_MINE,
    spill: [],
    complete: false,
    outOfEnergy: false,
    energy: left,
    notes: [],
  };

  const costOfMine = (id) => catalog?.get(id)?.cost ?? costOf(id);
  const powerOfMine = (id) => catalog?.get(id)?.powerRequired ?? 0;

  async function startVein(mineId, spot) {
    const cost = costOfMine(mineId);
    if (left < cost) {
      record.outOfEnergy = true;
      return "no-energy";
    }
    try {
      const { body } = await miningPositions(wallet, {
        locationId: mineId,
        spotId: spot.id,
        strategy: STRATEGY,
        gear,
        verbose: false,
      });
      record.started += 1;
      left = typeof body?.user?.energy === "number" ? body.user.energy : left - cost;
      return "started";
    } catch (error) {
      if (error.body?.code === "NOT_ENOUGH_ENERGY") {
        record.outOfEnergy = true;
        left = Math.min(left, cost);
        return "no-energy";
      }
      const detail = error.body?.error || error.body?.message || error.message;
      record.notes.push(`${describeMine(mineId)} ${spot.id}: ${detail}`);
      return "error";
    }
  }

  /** Fills every idle vein of one mine and reports what is still not digging. */
  async function fill(mineId, { stopOnError }) {
    if (power < powerOfMine(mineId)) {
      record.notes.push(
        `${describeMine(mineId)} needs ${powerOfMine(mineId)} mining power, wallet has ${power}`,
      );
      return { total: 0, idle: 0, started: 0, veins: 0, blocked: true };
    }

    const { body } = await listMiningSpots(wallet, mineId);
    const spots = Array.isArray(body?.spots) ? body.spots : [];
    const idle = spots.filter((spot) => !spot.occupied && !busy.has(spot.id));
    let started = 0;

    for (const spot of idle) {
      const outcome = await startVein(mineId, spot);
      if (outcome === "started") {
        started += 1;
        busy.add(spot.id);
        continue;
      }
      if (outcome === "no-energy") break;
      if (stopOnError) break;
    }

    return {
      total: spots.length,
      idle: idle.length,
      started,
      veins: spots.length - idle.length + started,
      blocked: false,
    };
  }

  const appointed = await fill(mine, { stopOnError: true });
  record.veins = appointed.veins;
  record.total = appointed.total || VEINS_PER_MINE;
  // Every idle vein got armed (or there were none) = all six are digging now.
  record.complete = !appointed.blocked && appointed.total > 0 && appointed.idle === appointed.started;

  if (record.complete) {
    for (let index = rankOf(mine) - 1; index >= 0; index -= 1) {
      if (record.outOfEnergy) break;
      const lower = MINES[index];
      const result = await fill(lower.id, { stopOnError: false });
      if (result.started > 0) record.spill.push({ mine: lower.id, started: result.started });
    }
  }

  record.energy = left;
  return record;
}
