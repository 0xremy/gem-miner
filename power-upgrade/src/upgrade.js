/**
 * Mining Power I is a flat upgrade: +5 power for 250 gems (2 → 7 → 12 … 62).
 * So the number of purchases a wallet needs is arithmetic — read the balance
 * once, divide, then buy exactly that many times.
 */

export function planUpgrades({ power, gems, target, cost, increment }) {
  const missing = Math.max(0, target - power);
  const needed = Math.ceil(missing / increment);
  const affordable = Math.max(0, Math.floor(gems / cost));
  return { needed, affordable, count: Math.min(needed, affordable) };
}

/**
 * Reads the wallet, buys until it reaches `target` (or gems run out), then
 * reads it again to confirm what actually happened.
 *
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.address
 * @param {{ balance: () => Promise<any>, buyPower: () => Promise<any> }} options.client
 * @param {number} options.target
 * @param {number} options.cost
 * @param {number} options.increment
 * @param {boolean} [options.dryRun]
 */
export async function upgradeWallet({
  name,
  address,
  client,
  target,
  cost,
  increment,
  dryRun = false,
}) {
  const start = await client.balance();
  const startPower = Number(start?.miningPower);
  const startGems = Number(start?.gems);
  if (!Number.isFinite(startPower)) {
    throw new Error("balance response contained no miningPower");
  }
  if (!Number.isFinite(startGems)) {
    throw new Error("balance response contained no gems");
  }

  const plan = planUpgrades({ power: startPower, gems: startGems, target, cost, increment });
  const record = {
    name,
    address,
    startPower,
    startGems,
    endPower: startPower,
    endGems: startGems,
    needed: plan.needed,
    affordable: plan.affordable,
    count: plan.count,
    bought: 0,
    dryRun,
    buyError: null,
    verified: false,
  };

  if (dryRun || plan.count === 0) return record;

  try {
    for (let i = 0; i < plan.count; i += 1) {
      const result = await client.buyPower();
      if (result?.success === false) {
        throw new Error(result.message || "the upgrade endpoint refused the purchase");
      }
      record.bought += 1;

      // The response carries the post-purchase user, so the next iteration does
      // not need another balance read.
      const user = result?.user;
      if (user && Number.isFinite(Number(user.miningPower))) {
        record.endPower = Number(user.miningPower);
        record.endGems = Number(user.gems ?? record.endGems);
      } else {
        record.endPower += increment;
        record.endGems -= cost;
      }

      if (record.endPower >= target) break;
      if (record.endGems < cost) break;
    }
  } catch (error) {
    record.buyError = error.message;
  }

  // Confirm with a fresh read rather than trusting the running tally.
  try {
    const final = await client.balance();
    if (Number.isFinite(Number(final?.miningPower))) record.endPower = Number(final.miningPower);
    if (Number.isFinite(Number(final?.gems))) record.endGems = Number(final.gems);
    record.verified = true;
  } catch (error) {
    record.verifyError = error.message;
  }

  return record;
}
