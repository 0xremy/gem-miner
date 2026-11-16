/**
 * Shop items are bought one per request:
 *
 *   POST /api/shop/purchase   { itemId: "iron-pickaxe" }
 *   → { success, item: { id, price, effect }, user: { gems, miningPower, … }, inventory }
 *
 * Same call for every item, so the flow is driven by the catalog: pick ids,
 * read each price from `/api/shop/items`, and buy each one `count` times while
 * the wallet can still afford it.
 */

import { fetch as undiciFetch } from "undici";
import { config } from "./config.js";

/** `/api/shop/items` is public, so the catalog needs no wallet token. */
export async function loadCatalog() {
  const response = await undiciFetch(new URL("/api/shop/items", config.baseUrl), {
    headers: { accept: "*/*", "user-agent": process.env.GEM_USER_AGENT || "power-upgrade" },
  });
  if (!response.ok) throw new Error(`GET /api/shop/items → ${response.status}`);
  const catalog = await response.json();
  if (!Array.isArray(catalog)) throw new Error("the shop catalog was not a list of items");
  return catalog;
}

/** How many of one item fit in the current gems, capped at the wanted count. */
export function planPurchase({ gems, price, count }) {
  if (!Number.isFinite(price) || price <= 0) return { affordable: 0, count: 0 };
  const affordable = Math.max(0, Math.floor(gems / price));
  return { affordable, count: Math.min(count, affordable) };
}

/**
 * Buys each requested item for one wallet, then reads the balance again to
 * confirm what actually happened. Never buys an item the wallet cannot afford.
 *
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.address
 * @param {{ balance: () => Promise<any>, purchase: (id: string) => Promise<any> }} options.client
 * @param {Array<{id: string, name: string, price: number, effect?: any}>} options.catalog
 * @param {string[]} options.itemIds
 * @param {number} options.count           how many of each item
 * @param {boolean} [options.dryRun]
 */
export async function buyItems({
  name,
  address,
  client,
  catalog,
  itemIds,
  count,
  dryRun = false,
}) {
  const start = await client.balance();
  const startGems = Number(start?.gems);
  const startPower = Number(start?.miningPower);
  if (!Number.isFinite(startGems)) {
    throw new Error("balance response contained no gems");
  }

  const wanted = itemIds.map((id) => {
    const item = catalog.find((entry) => entry.id === id);
    if (!item) throw new Error(`unknown item "${id}" — check --list-items for the shop catalog`);
    return item;
  });

  const record = {
    name,
    address,
    startGems,
    endGems: startGems,
    startPower: Number.isFinite(startPower) ? startPower : null,
    endPower: Number.isFinite(startPower) ? startPower : null,
    items: [],
    bought: 0,
    planned: 0,
    dryRun,
    buyError: null,
    verified: false,
  };

  let gemsLeft = startGems;

  for (const item of wanted) {
    const price = Number(item.price);
    const plan = planPurchase({ gems: gemsLeft, price, count });
    const entry = {
      id: item.id,
      name: item.name,
      price,
      wanted: count,
      affordable: plan.affordable,
      bought: 0,
      owned: false,
    };
    entry.planned = plan.count;
    record.items.push(entry);
    record.planned += plan.count;

    if (dryRun) {
      gemsLeft -= plan.count * price;
      record.endGems = gemsLeft;
      continue;
    }
    if (plan.count === 0) continue;

    for (let i = 0; i < plan.count; i += 1) {
      try {
        const result = await client.purchase(item.id);
        if (result?.success === false) {
          throw new Error(result.message || "the shop refused the purchase");
        }
        entry.bought += 1;
        record.bought += 1;

        // The response carries the post-purchase user, so gems and power stay
        // accurate without another balance read per purchase.
        const user = result?.user;
        if (user && Number.isFinite(Number(user.gems))) {
          record.endGems = Number(user.gems);
          if (Number.isFinite(Number(user.miningPower))) record.endPower = Number(user.miningPower);
        } else {
          record.endGems -= price;
          record.endPower += Number(item.effect?.miningPower ?? 0);
        }
        gemsLeft = record.endGems;
        if (gemsLeft < price) break;
      } catch (error) {
        // Equipment is unique per wallet: 400 "You already own X! Equipment
        // cannot be purchased twice." That is a skip, not a failure.
        const detail = String(error.body?.error || error.body?.message || "");
        if (/already own|cannot be purchased twice/i.test(detail)) {
          entry.owned = true;
          break;
        }
        record.buyError = `${item.id}: ${detail || error.message}`;
        break;
      }
    }
    if (record.buyError) break;
  }

  // Confirm with a fresh read rather than trusting the running tally. A dry
  // run keeps its projection instead — nothing was spent to confirm.
  if (!dryRun) {
    try {
      const final = await client.balance();
      if (Number.isFinite(Number(final?.gems))) record.endGems = Number(final.gems);
      if (Number.isFinite(Number(final?.miningPower))) record.endPower = Number(final.miningPower);
      record.verified = true;
    } catch (error) {
      record.verifyError = error.message;
    }
  }

  return record;
}
