/**
 * The inventory endpoint, as the game frontend calls it:
 *
 *   GET /api/user/inventory
 *   → [ { id, assetId: "mine-cart-1", name: "Mine Cart Mk I", type: "gear", quantity: 1, rarity }, … ]
 *
 * The response is the bare array; older/other shapes wrap it in
 * `{ inventory: [...] }` or `{ data: [...] }`, so all three are accepted.
 */

/** Normalizes any of the known inventory shapes into an array. */
export function inventoryList(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.inventory)) return response.inventory;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

/** How many of `assetId` the wallet holds; 0 when the entry is missing. */
export function quantityOf(list, assetId) {
  let total = 0;
  for (const entry of list) {
    if (entry?.assetId !== assetId) continue;
    const quantity = Number(entry.quantity);
    total += Number.isFinite(quantity) ? quantity : 0;
  }
  return total;
}

/** Reads one wallet's inventory and reports it in the shape callers want. */
export async function readInventory(client, assetId) {
  const list = inventoryList(await client.inventory());
  return { list, quantity: quantityOf(list, assetId) };
}
