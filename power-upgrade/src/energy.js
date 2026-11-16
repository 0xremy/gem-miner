/**
 * Energy Capacity is a repeatable upgrade rather than a targeted one:
 *
 *   POST /api/upgrades/upg-energy-1
 *   → { success, message, upgrade: { id, increment, cost }, user: { gems, energyCapacity, … } }
 *
 * There is no target: the goal is to spend the wallet's gems on capacity until
 * it can no longer afford the next level.
 *
 * The price is NOT assumed to be constant — it changes over time and with
 * level — so this loop never compares the wallet's gems against a remembered
 * price to decide whether to continue. It just asks for the next level and
 * stops when the API itself refuses (out of gems, or maxed out). The refusal
 * carries the price it wanted, which is reported as the leftover.
 */

const MAX_BUYS = 5000; // a hard stop against a runaway loop, not a price estimate

const MAXED = /max|cap|limit|level/i;
const UNAFFORDABLE = /gems|afford|insufficient|not enough|balance|cost|price|coin/i;

/** Pull a price out of whatever shape the refusal used. */
function priceOf(body) {
  const candidates = [body?.upgrade?.cost, body?.cost, body?.price, body?.upgrade?.price];
  for (const candidate of candidates) {
    const price = Number(candidate);
    if (Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

/**
 * Spends a wallet's gems on Energy Capacity upgrades.
 *
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.address
 * @param {{ balance: () => Promise<any>, buyEnergy: () => Promise<any> }} options.client
 * @param {number} options.increment   capacity added per level (fallback only)
 * @param {boolean} [options.dryRun]
 */
export async function upgradeEnergy({ name, address, client, increment, dryRun = false }) {
  const start = await client.balance();
  const startGems = Number(start?.gems);
  const startCapacity = Number(start?.energyCapacity);
  if (!Number.isFinite(startGems)) throw new Error("balance response contained no gems");
  if (!Number.isFinite(startCapacity)) {
    throw new Error("balance response contained no energyCapacity");
  }

  const record = {
    name,
    address,
    startGems,
    endGems: startGems,
    startCapacity,
    endCapacity: startCapacity,
    startPower: Number.isFinite(Number(start?.miningPower)) ? Number(start.miningPower) : null,
    endPower: Number.isFinite(Number(start?.miningPower)) ? Number(start.miningPower) : null,
    bought: 0,
    dryRun,
    atMax: false,
    stopReason: null,
    lastPrice: null,
    nextPrice: null,
    buyError: null,
    verified: false,
  };

  // Without buying, the next price is unknown — and guessing it from a fixed
  // cost is exactly what this mode avoids. A dry run therefore only reads.
  if (dryRun) return record;

  while (record.bought < MAX_BUYS) {
    let result;
    try {
      result = await client.buyEnergy();
    } catch (error) {
      const body = error.body ?? {};
      const detail = String(body.error || body.message || error.message);
      const wanted = priceOf(body);
      if (wanted) record.nextPrice = wanted;

      // 400 is the API saying "no". Work out which "no" it is.
      if (error.status === 400) {
        if (MAXED.test(detail)) {
          record.atMax = true;
          record.stopReason = detail;
          break;
        }
        if (UNAFFORDABLE.test(detail)) {
          record.stopReason = detail;
          break;
        }
        // A refusal this loop cannot explain is a real problem, not a stop.
        record.buyError = detail;
        break;
      }

      record.buyError = detail;
      break;
    }

    if (result?.success === false) {
      record.buyError = result.message || "the upgrade endpoint refused the purchase";
      break;
    }

    record.bought += 1;

    // The response carries the post-purchase user, so the next iteration does
    // not need another balance read.
    const user = result?.user;
    if (user && Number.isFinite(Number(user.gems))) record.endGems = Number(user.gems);
    if (user && Number.isFinite(Number(user.energyCapacity))) {
      record.endCapacity = Number(user.energyCapacity);
    } else {
      record.endCapacity += increment;
    }
    if (user && Number.isFinite(Number(user.miningPower))) record.endPower = Number(user.miningPower);

    // Recorded for the report only; it never gates the next iteration.
    const reported = Number(result?.upgrade?.cost);
    if (Number.isFinite(reported) && reported > 0) record.lastPrice = reported;
  }

  // Confirm with a fresh read rather than trusting the running tally.
  try {
    const final = await client.balance();
    if (Number.isFinite(Number(final?.gems))) record.endGems = Number(final.gems);
    if (Number.isFinite(Number(final?.energyCapacity))) {
      record.endCapacity = Number(final.energyCapacity);
    }
    if (Number.isFinite(Number(final?.miningPower))) record.endPower = Number(final.miningPower);
    record.verified = true;
  } catch (error) {
    record.verifyError = error.message;
  }

  return record;
}
