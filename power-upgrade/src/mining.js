/**
 * The mining loop for one wallet.
 *
 * Mines now hold six veins each, and a position is tied to one vein (`spotId`)
 * and one strategy.  Every pass does the same four things:
 *
 *   1. read the wallet's balance and its positions
 *   2. claim every vein whose timer has run out
 *   3. start the "deep" strategy on every vein of the appointed mine that is
 *      not digging yet, until all six are busy
 *   4. only when all six are busy and energy is left over, walk down the rank
 *      list and fill idle veins there too
 *
 * A mine that still has idle veins after step 3 is reported as incomplete and
 * left alone until the next pass — that is the "wait for the next loop" case.
 */

/** Low → high rank. A wallet spills downward, never upward. */
export const MINES = [
  { id: "greenstone-quarry", name: "Greenstone Quarry" },
  { id: "crystal-cavern", name: "Crystal Cavern" },
  { id: "ember-mine", name: "Ember Mine" },
  { id: "frozen-depths", name: "Frozen Depths" },
  { id: "void-rift", name: "Void Rift" },
  { id: "molten-core", name: "Molten Core" },
];

/** Used when the sheet's Location cell is blank, like the miner's default. */
export const DEFAULT_MINE = "greenstone-quarry";

/** The only strategy this app uses: longest run, best multipliers. */
export const STRATEGY = "deep";

/** Every mine exposes this many veins per refresh. */
export const VEINS_PER_MINE = 6;

const keyOf = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** "Ember Mine", "ember", "EMBER-MINE" → "ember-mine"; null when unknown. */
export function resolveMine(value) {
  const wanted = keyOf(value);
  if (!wanted) return null;
  const match = (mine) =>
    keyOf(mine.id) === wanted ||
    keyOf(mine.name) === wanted ||
    keyOf(mine.id).startsWith(wanted) ||
    keyOf(mine.name).startsWith(wanted);
  return MINES.find(match)?.id ?? null;
}

export const mineName = (id) => MINES.find((mine) => mine.id === id)?.name ?? id;

export const rankOf = (id) => MINES.findIndex((mine) => mine.id === id);

/** A position can be collected once its window elapsed and it is not claimed. */
export function isClaimable(position) {
  if (!position || position.status === "claimed") return false;
  if (typeof position.remainingSeconds === "number" && position.remainingSeconds > 0) return false;
  return true;
}

/**
 * GET /api/mining/locations is wallet-independent for what we need (deep cost
 * and duration), so it is fetched once per process and shared by every wallet.
 */
let catalogPromise = null;

export function loadMiningCatalog(client) {
  if (!catalogPromise) {
    catalogPromise = client.locations().then((list) => {
      const catalog = new Map();
      for (const mine of Array.isArray(list) ? list : []) {
        const deep = (mine.strategies ?? []).find((strategy) => strategy.id === STRATEGY);
        catalog.set(mine.id, {
          id: mine.id,
          name: mine.name,
          powerRequired: Number(mine.miningPowerRequired ?? 0),
          deepEnergyCost: Number(deep?.energyCost ?? mine.energyCost ?? 0),
          deepSeconds: Number(deep?.durationSeconds ?? mine.durationSeconds ?? 0),
        });
      }
      return catalog;
    });
    // A failed fetch must not poison every later wallet.
    catalogPromise.catch(() => {
      catalogPromise = null;
    });
  }
  return catalogPromise;
}

const deepCostOf = (catalog, mineId, fallback = 0) =>
  catalog?.get(mineId)?.deepEnergyCost ?? fallback;

/**
 * One pass for one wallet. Mutates the game state unless `dryRun`.
 *
 * @returns {Promise<{
 *   name: string, address: string, mine: string, mineLabel: string,
 *   gear: string|null, energyStart: number, energyEnd: number,
 *   claims: number, gems: number, claimedVeins: string[],
 *   started: number, veins: number, total: number,
 *   spill: Array<{ mine: string, started: number }>,
 *   complete: boolean, outOfEnergy: boolean, dryRun: boolean,
 *   notes: string[],
 * }>}
 */
export async function runMining({ name, address, client, mine, gear = null, dryRun = false }) {
  const catalog = await loadMiningCatalog(client);
  const balance = await client.balance();
  const power = Number(balance?.miningPower ?? 0);
  let energy = Number(balance?.energy ?? 0);
  const positions = (await client.positions()) ?? [];

  const record = {
    name,
    address,
    mine,
    mineLabel: mineName(mine),
    gear: gear || null,
    energyStart: energy,
    energyEnd: energy,
    claims: 0,
    gems: 0,
    claimedVeins: [],
    started: 0,
    veins: 0,
    total: VEINS_PER_MINE,
    spill: [],
    complete: false,
    outOfEnergy: false,
    dryRun,
    notes: [],
  };

  // 1. Collect finished veins first, so their energy is not double-counted
  //    against the new ones we are about to arm.
  const claimable = positions.filter(isClaimable);
  if (dryRun) {
    record.claims = claimable.length;
  } else {
    for (const position of claimable) {
      try {
        const body = await client.claimPosition(position.id);
        const earned = Number(body?.gemsEarned ?? 0);
        record.claims += 1;
        record.gems += earned;
        record.claimedVeins.push(position.spotId || position.locationId || position.id);
        if (typeof body?.user?.energy === "number") energy = body.user.energy;
      } catch (error) {
        record.notes.push(`claim ${position.id}: ${error.message}`);
      }
    }
  }

  // Veins this wallet is already digging — the server's `occupied` flag says
  // the same thing, but positions are authoritative across both.
  const busySpots = new Set(
    positions
      .filter((position) => position.spotId && !isClaimable(position))
      .map((position) => position.spotId),
  );

  async function startVein(mineId, spot) {
    const cost = deepCostOf(catalog, mineId);
    if (energy < cost) {
      record.outOfEnergy = true;
      return "no-energy";
    }
    if (dryRun) {
      energy -= cost;
      record.started += 1;
      return "started";
    }
    try {
      const body = await client.startPosition({
        locationId: mineId,
        spotId: spot.id,
        strategy: STRATEGY,
        gear: record.gear,
      });
      record.started += 1;
      if (typeof body?.user?.energy === "number") energy = body.user.energy;
      else energy -= cost;
      return "started";
    } catch (error) {
      if (error.body?.code === "NOT_ENOUGH_ENERGY") {
        record.outOfEnergy = true;
        energy = Math.min(energy, cost);
        return "no-energy";
      }
      record.notes.push(`${mineId} ${spot.id}: ${error.message}`);
      return "error";
    }
  }

  /** Fills every idle vein of one mine. Returns what is still not digging. */
  async function fillMine(mineId, { stopOnError }) {
    const body = await client.spots(mineId);
    const spots = Array.isArray(body?.spots) ? body.spots : [];
    const idle = spots.filter((spot) => !spot.occupied && !busySpots.has(spot.id));
    let started = 0;
    for (const spot of idle) {
      const outcome = await startVein(mineId, spot);
      if (outcome === "started") {
        started += 1;
        busySpots.add(spot.id);
        continue;
      }
      if (outcome === "no-energy") break;
      if (stopOnError) break;
    }
    return { mineId, total: spots.length, idle: idle.length, started, veins: spots.length - idle.length + started };
  }

  const appointed = await fillMine(record.mine, { stopOnError: true });
  record.veins = appointed.veins;
  record.total = appointed.total || VEINS_PER_MINE;
  record.notes.push(
    ...(catalog.has(record.mine) && power < catalog.get(record.mine).powerRequired
      ? [`${record.mine} needs ${catalog.get(record.mine).powerRequired} power, wallet has ${power}`]
      : []),
  );
  // All six veins digging (already or now) is the signal to spill downward.
  record.complete = appointed.total > 0 && appointed.idle === appointed.started;

  if (record.complete) {
    const rank = rankOf(record.mine);
    for (let index = rank - 1; index >= 0; index -= 1) {
      if (record.outOfEnergy) break;
      const lower = MINES[index];
      const result = await fillMine(lower.id, { stopOnError: false });
      if (result.started > 0) record.spill.push({ mine: lower.id, started: result.started });
    }
  }

  record.energyEnd = energy;
  return record;
}
