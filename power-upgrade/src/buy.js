#!/usr/bin/env node
import { config } from "./config.js";
import { createClient } from "./api.js";
import { openSheets, readSheetIndex, sheetIdFrom } from "./sheet.js";
import { parseProxy } from "./proxy.js";
import { buyItem } from "./buy-item.js";

/**
 * Buys one shop item for every wallet in the sheet — by default Mine Cart Mk I
 * (mine-cart-1, 4,500 gems). Each wallet's inventory is checked first, so only
 * wallets that do not own the item yet are charged: one purchase per wallet.
 *
 *   node src/buy.js --dry-run     → read balances, print what would be bought
 *   node src/buy.js --limit 2     → only the first two wallets
 *   node src/buy.js --only 0x…    → one wallet
 *
 * Tokens and proxies come from the Google Sheet, so run the token refresher
 * first when tokens are close to their 72 h expiry. Every request leaves
 * through that wallet's own proxy.
 */

const USAGE = `
Usage: node src/buy.js [options]

  --dry-run            read balances and print the plan; buy nothing
  --item <id>          shop item id (default ${config.shopItemId})
  --price <gems>       expected price, for the dry run (default ${config.shopItemPrice}; live reads use the response's price)
  --only <addresses>   only these wallet addresses (comma separated)
  --limit <n>          stop after n wallets
  --no-proxy           ignore the sheet's Proxy column (uses your own IP)
  --fallback-direct    retry a wallet whose proxy fails over your own IP
  --concurrency <n>    parallel wallets (default ${config.concurrency})
`;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    only: null,
    noProxy: false,
    fallbackDirect: false,
    limit: Infinity,
    item: config.shopItemId,
    price: config.shopItemPrice,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--only") args.only = next().split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    else if (arg === "--no-proxy") args.noProxy = true;
    else if (arg === "--fallback-direct") args.fallbackDirect = true;
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg === "--concurrency") args.concurrency = Math.max(1, Number(next()));
    else if (arg === "--item") args.item = next().trim();
    else if (arg === "--price") args.price = Number(next());
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown option ${arg}\n${USAGE}`);
  }
  return args;
}

/** Runs `worker` over `items` with a small pool; keeps input order in results. */
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

const gems = (n) => Math.round(n).toLocaleString("en-US");

/** Prints one wallet as soon as it finishes, so a long run is watchable. */
function reportLine(entry) {
  const via = entry.proxy ? `, via ${entry.proxy.label}` : "";
  const money = `gems ${gems(entry.startGems)} → ${gems(entry.endGems)}${via}`;

  if (entry.error) {
    const hint = entry.error.status === 401 ? " (token expired — run the token refresher)" : "";
    console.log(`✗ ${entry.name} ${entry.address}: ${entry.error.message}${hint}`);
  } else if (entry.buyError) {
    console.log(`✗ ${entry.name} ${entry.address}: ${entry.buyError} (${money})`);
  } else if (entry.bought > 0) {
    const item = entry.itemName ? ` ${entry.itemName}` : ` ${entry.itemId}`;
    const proof = entry.ownsAfter === false ? " — item missing from the returned inventory" : "";
    console.log(
      `✓ ${entry.name} ${entry.address}: bought${item} for ${gems(entry.price ?? 0)} gems, ${money}${proof}`,
    );
  } else if (entry.alreadyOwned) {
    console.log(`= ${entry.name} ${entry.address}: already owns ${entry.itemId} (${money})`);
  } else if (entry.unaffordable) {
    console.log(
      `⚠ ${entry.name} ${entry.address}: ${gems(entry.startGems)} gems < ${gems(entry.price ?? 0)} — cannot afford ${entry.itemId}`,
    );
  } else if (entry.dryRun) {
    console.log(
      `· ${entry.name} ${entry.address}: ${gems(entry.startGems)} gems, price ${gems(entry.price ?? 0)} — would buy ${entry.itemId}${via}`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const spreadsheetId = sheetIdFrom(config.sheetId);
  const sheets = await openSheets();
  const layout = await readSheetIndex(sheets, spreadsheetId);
  console.log(`sheet: tab "${layout.tab}", ${layout.rowsByAddress.size} wallet row(s)`);

  let addresses = [...layout.rowsByAddress.keys()];
  if (args.only) addresses = addresses.filter((address) => args.only.includes(address));
  if (addresses.length === 0) throw new Error("no wallet rows matched");

  const batch = addresses.slice(0, args.limit);
  const withProxy = batch.filter((address) => layout.proxiesByAddress.get(address)).length;
  console.log(
    `wallets: ${batch.length}${args.only ? "" : ` of ${addresses.length}`}, ${withProxy} with a proxy`,
  );
  console.log(
    `shop: ${args.item} at ${gems(args.price)} gems — inventory checked first, ` +
      `wallets that already own it are skipped\n`,
  );
  if (args.dryRun) console.log("dry run: balances are read, no gems are spent\n");

  const outcome = await mapPool(batch, args.concurrency ?? config.concurrency, async (address) => {
    const name = layout.namesByAddress.get(address) ?? address.slice(0, 10);
    const token = layout.tokensByAddress.get(address);
    let proxy = null;
    let entry;
    const buy = (client) =>
      buyItem({
        name,
        address,
        client,
        itemId: args.item,
        price: args.price,
        dryRun: args.dryRun,
      });
    try {
      if (!token) throw new Error("no token in the sheet — run the token refresher first");
      proxy = args.noProxy ? null : parseProxy(layout.proxiesByAddress.get(address));
      let record;
      try {
        record = await buy(createClient({ token, address, proxy }));
      } catch (error) {
        if (!args.fallbackDirect || !proxy) throw error;
        console.log(`~ ${name} ${address}: proxy ${proxy.label} failed, retrying direct`);
        record = await buy(createClient({ token, address, proxy: null }));
        record.note = `direct fallback — proxy ${proxy.label} failed: ${error.message}`;
      }
      entry = { ...record, proxy };
    } catch (error) {
      entry = { name, address, proxy, error };
    }
    reportLine(entry);
    return entry;
  });

  const done = outcome.filter((entry) => !entry.error);
  const failed = outcome.filter((entry) => entry.error || entry.buyError);
  const bought = done.filter((entry) => entry.bought > 0).length;
  const spent = done.reduce((sum, entry) => sum + Math.max(0, entry.startGems - entry.endGems), 0);
  const owned = done.filter((entry) => entry.alreadyOwned).length;
  const poor = done.filter((entry) => entry.unaffordable).length;
  const planned = done.filter(
    (entry) => entry.dryRun && !entry.unaffordable && !entry.alreadyOwned,
  ).length;

  if (args.dryRun) {
    console.log(
      `\ndry run: ${planned} wallet(s) could pay for ${args.item} — ` +
        `${poor} cannot afford it, ${owned} already own it, ${failed.length} failed; nothing was bought`,
    );
  } else {
    console.log(
      `\nbought ${args.item} for ${bought}/${batch.length} wallet(s), ${gems(spent)} gems spent — ` +
        `${owned} already owned, ${poor} cannot afford, ${failed.length} failed`,
    );
  }
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
