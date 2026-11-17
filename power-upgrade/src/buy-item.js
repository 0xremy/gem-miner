/**
 * One shop purchase per wallet:
 *
 *   GET  /api/user/inventory                       → [ { assetId, quantity, … } ]
 *   POST /api/shop/purchase  { itemId: "mine-cart-1" }
 *   → { success, item: { id, name, price, … }, user: { gems, … }, inventory: [{ assetId, quantity }] }
 *
 * Ownership is checked first, so a wallet that already holds the item costs no
 * purchase request and is reported as skipped. A 400 "already own…" is still
 * classified the same way, in case the inventory read is unavailable. The price
 * is read from the live response — the `price` argument is only used to tell an
 * obviously unaffordable wallet apart before spending a request on it.
 */

import { readInventory } from "./inventory.js";

const ALREADY_OWNED = /already|duplicate|own(?:s|ed)? (?:this|it)/i;
const UNAFFORDABLE = /gems|afford|insufficient|not enough|balance|cost|price|coin/i;

/**
 * Buys `itemId` for one wallet.
 *
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.address
 * @param {{ balance: () => Promise<any>, inventory: () => Promise<any>, purchase: (itemId: string) => Promise<any> }} options.client
 * @param {string} options.itemId
 * @param {number} [options.price]  expected price, for the dry run and the affordability check
 * @param {boolean} [options.dryRun]
 */
export async function buyItem({ name, address, client, itemId, price = 0, dryRun = false }) {
  const start = await client.balance();
  const startGems = Number(start?.gems);
  if (!Number.isFinite(startGems)) throw new Error("balance response contained no gems");

  const knownPrice = Number.isFinite(price) && price > 0 ? price : null;
  const record = {
    name,
    address,
    itemId,
    itemName: null,
    startGems,
    endGems: startGems,
    price: knownPrice,
    bought: 0,
    dryRun,
    alreadyOwned: false,
    unaffordable: false,
    stopReason: null,
    buyError: null,
    verified: false,
  };

  // Ask the inventory first: the cart already on the account makes the whole
  // purchase pointless, and the shop would refuse it anyway.
  try {
    const { quantity } = await readInventory(client, itemId);
    record.ownsBefore = quantity > 0;
    record.inventoryQuantity = quantity;
    if (quantity > 0) {
      record.alreadyOwned = true;
      record.stopReason = `inventory holds ${quantity} × ${itemId}`;
      return record;
    }
  } catch (error) {
    // No inventory read: fall through and let the purchase response decide.
    record.inventoryError = error.message;
  }

  if (knownPrice !== null && startGems < knownPrice) {
    record.unaffordable = true;
    record.stopReason = `owns ${Math.round(startGems)} gems, needs ${knownPrice}`;
    return record;
  }

  // Ownership is now known, so a dry run can be precise: it still only reads.
  if (dryRun) return record;

  try {
    const result = await client.purchase(itemId);
    if (result?.success === false) {
      throw new Error(result.message || "the shop refused the purchase");
    }

    record.bought = 1;
    record.itemName = result?.item?.name ?? null;
    const charged = Number(result?.item?.price);
    if (Number.isFinite(charged) && charged > 0) record.price = charged;

    const user = result?.user;
    if (user && Number.isFinite(Number(user.gems))) {
      record.endGems = Number(user.gems);
    } else if (record.price !== null) {
      record.endGems -= record.price;
    }

    // The response's inventory is the proof the cart is now on the account.
    if (Array.isArray(result?.inventory)) {
      record.ownsAfter = result.inventory.some(
        (entry) => entry?.assetId === itemId && Number(entry.quantity) > 0,
      );
    }
  } catch (error) {
    const body = error.body ?? {};
    const detail = String(body.error || body.message || error.message);
    if (error.status === 400 && ALREADY_OWNED.test(detail)) {
      record.alreadyOwned = true;
      record.stopReason = detail;
    } else if (error.status === 400 && UNAFFORDABLE.test(detail)) {
      record.unaffordable = true;
      record.stopReason = detail;
    } else {
      record.buyError = detail;
    }
  }

  // Confirm with a fresh read rather than trusting the running tally.
  try {
    const final = await client.balance();
    if (Number.isFinite(Number(final?.gems))) record.endGems = Number(final.gems);
    record.verified = true;
  } catch (error) {
    record.verifyError = error.message;
  }

  return record;
}
