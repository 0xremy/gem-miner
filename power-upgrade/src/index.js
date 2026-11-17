#!/usr/bin/env node
import { config } from "./config.js";
import { createClient } from "./api.js";
import { openSheets, readSheetIndex, sheetIdFrom } from "./sheet.js";
import { parseProxy } from "./proxy.js";
import { upgradeWallet } from "./upgrade.js";
import { upgradeEnergy } from "./energy.js";

/**
 * Buys Mining Power I for every wallet in the sheet until its mining power
 * reaches TARGET_POWER (default 62: +5 per purchase from 2), or — with
 * `--energy` — raises Energy Capacity until the API or the wallet's gems say no.
 *
 *   node src/index.js --dry-run     → read balances, print the plan, buy nothing
 *   node src/index.js --limit 2     → only the first two wallets
 *   node src/index.js --only 0x…    → one wallet
 *
 * Tokens and proxies come from the Google Sheet, so run the token refresher
 * first when tokens are close to their 72 h expiry.
 */

const USAGE = `
Usage: node src/index.js [options]

  --dry-run            read balances and print the plan; buy nothing
  --only <address>     only this wallet address
  --limit <n>          stop after n wallets
  --no-proxy           ignore the sheet's Proxy column (uses your own IP)
  --concurrency <n>    parallel wallets (default ${config.concurrency})
  --target <power>     stop at this mining power (default ${config.targetPower})
  --energy             spend each wallet's gems on Energy Capacity instead
`;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    only: null,
    noProxy: false,
    limit: Infinity,
    target: config.targetPower,
    energy: false,
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
    else if (arg === "--only") args.only = next().trim().toLowerCase();
    else if (arg === "--no-proxy") args.noProxy = true;
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg === "--concurrency") args.concurrency = Math.max(1, Number(next()));
    else if (arg === "--target") args.target = Number(next());
    else if (arg === "--energy") args.energy = true;
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
function reportLine(entry, target) {
  const via = entry.proxy ? `, via ${entry.proxy.label}` : "";
  if (entry.error) {
    const hint = entry.error.status === 401 ? " (token expired — run the token refresher)" : "";
    console.log(`✗ ${entry.name} ${entry.address}: ${entry.error.message}${hint}`);
    return;
  }
  const spent = entry.startGems - entry.endGems;
  const trail = `${entry.startPower} → ${entry.endPower} power, gems ${gems(entry.startGems)} → ${gems(entry.endGems)}${via}`;

  if (entry.energy) {
    const capacity = `energy ${gems(entry.startCapacity)} → ${gems(entry.endCapacity)}`;
    const money = `gems ${gems(entry.startGems)} → ${gems(entry.endGems)}${via}`;
    if (entry.buyError) {
      console.log(
        `✗ ${entry.name} ${entry.address}: ${entry.buyError} (${entry.bought} bought, ${capacity}, ${money})`,
      );
    } else if (entry.dryRun) {
      console.log(
        `· ${entry.name} ${entry.address}: ${capacity}, ${money} — next price is only known by buying`,
      );
    } else if (entry.bought > 0) {
      const next = entry.nextPrice ? `, next level costs ${gems(entry.nextPrice)}` : "";
      console.log(
        `✓ ${entry.name} ${entry.address}: ${entry.bought}× energy (+${gems(
          Math.round(entry.endCapacity - entry.startCapacity),
        )} capacity), ${capacity}, ${money}${next}`,
      );
    } else if (entry.atMax) {
      console.log(`= ${entry.name} ${entry.address}: energy at max (${capacity}), ${money}`);
    } else {
      const wanted = entry.nextPrice ? `costs ${gems(entry.nextPrice)} gems, ` : "";
      console.log(
        `⚠ ${entry.name} ${entry.address}: cannot afford the next energy level (${wanted}${capacity}), ${money}`,
      );
    }
    return;
  }

  if (entry.buyError) {
    console.log(`✗ ${entry.name} ${entry.address}: ${entry.buyError} (${entry.bought} bought, ${trail})`);
  } else if (entry.verified && entry.endPower < target) {
    console.log(
      `⚠ ${entry.name} ${entry.address}: ${trail} — ${entry.bought}/${entry.needed} bought, ${entry.endPower - entry.startPower} power short of ${target}`,
    );
  } else if (entry.bought > 0) {
    console.log(
      `✓ ${entry.name} ${entry.address}: ${trail} (+${entry.bought}, ${gems(spent)} gems${entry.dryRun ? ", planned" : ""})`,
    );
  } else if (entry.needed === 0) {
    console.log(`= ${entry.name} ${entry.address}: already ${entry.startPower} power${via}`);
  } else if (entry.dryRun) {
    console.log(
      `· ${entry.name} ${entry.address}: ${entry.startPower} power, ${gems(entry.startGems)} gems — needs ${entry.needed} upgrade(s) = ${gems(entry.needed * config.upgradeCost)} gems${via}`,
    );
  } else {
    console.log(
      `⚠ ${entry.name} ${entry.address}: ${entry.startPower} power, ${gems(entry.startGems)} gems — cannot afford any of ${entry.needed} upgrade(s)${via}`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const concurrency = args.concurrency ?? config.concurrency;

  const spreadsheetId = sheetIdFrom(config.sheetId);
  const sheets = await openSheets();
  const layout = await readSheetIndex(sheets, spreadsheetId);
  console.log(
    `sheet: tab "${layout.tab}", ${layout.rowsByAddress.size} wallet row(s)` +
      (args.energy ? "" : `, target ${args.target} power`),
  );

  let addresses = [...layout.rowsByAddress.keys()];
  if (args.only) addresses = addresses.filter((address) => address === args.only);
  if (addresses.length === 0) throw new Error("no wallet rows matched");

  const batch = addresses.slice(0, args.limit);
  const withProxy = batch.filter((address) => layout.proxiesByAddress.get(address)).length;
  console.log(
    `wallets: ${batch.length}${args.only ? "" : ` of ${addresses.length}`}, ${withProxy} with a proxy`,
  );
  if (args.dryRun) console.log("dry run: balances are read, no gems are spent\n");

  if (args.energy) {
    console.log(
      `energy: ${config.energyUpgradeId} (+${config.energyIncrement} capacity) — buy until the API refuses; ` +
        `each price is read from the live response, never assumed\n`,
    );
  }

  const outcome = await mapPool(batch, concurrency, async (address) => {
    const name = layout.namesByAddress.get(address) ?? address.slice(0, 10);
    const token = layout.tokensByAddress.get(address);
    let proxy = null;
    let entry;
    try {
      if (!token) throw new Error("no token in the sheet — run the token refresher first");
      proxy = args.noProxy ? null : parseProxy(layout.proxiesByAddress.get(address));
      const client = createClient({ token, address, proxy });
      const record = args.energy
        ? await upgradeEnergy({
            name,
            address,
            client,
            increment: config.energyIncrement,
            dryRun: args.dryRun,
          })
        : await upgradeWallet({
            name,
            address,
            client,
            target: args.target,
            cost: config.upgradeCost,
            increment: config.upgradeIncrement,
            dryRun: args.dryRun,
          });
      entry = { ...record, proxy, energy: args.energy };
    } catch (error) {
      entry = { name, address, proxy, error };
    }
    reportLine(entry, args.target);
    return entry;
  });

  const done = outcome.filter((entry) => !entry.error);
  const failed = outcome.filter((entry) => entry.error || entry.buyError);
  const bought = done.reduce((sum, entry) => sum + entry.bought, 0);
  const spent = done.reduce((sum, entry) => sum + Math.max(0, entry.startGems - entry.endGems), 0);
  const planned = done.reduce((sum, entry) => sum + entry.count, 0);
  const upgraded = done.filter((entry) => (args.dryRun ? entry.count > 0 : entry.bought > 0));
  const atTarget = done.filter((entry) => entry.endPower >= args.target).length;
  const unaffordable = done.filter((entry) => entry.needed > 0 && entry.count === 0).length;
  const short = done.filter((entry) => entry.bought > 0 && entry.endPower < args.target).length;

  if (args.energy && args.dryRun) {
    console.log(
      `\ndry run: balances read for ${done.length}/${batch.length} wallet(s), nothing bought — ` +
        `every price is read live, so there is nothing to project; ${failed.length} failed`,
    );
  } else if (args.energy) {
    const charged = gems(spent);
    const refused = done.filter(
      (entry) => entry.bought === 0 && !entry.atMax && !entry.buyError,
    ).length;
    console.log(
      `\nbought ${bought} energy upgrade(s) for ${upgraded.length}/${batch.length} wallet(s), ${charged} gems spent — ` +
        `${done.filter((entry) => entry.atMax).length} at max, ${refused} cannot afford, ${failed.length} failed`,
    );
  } else if (args.dryRun) {
    console.log(
      `\nwould buy ${planned} upgrade(s) for ${upgraded.length}/${batch.length} wallet(s) — ` +
        `~${gems(planned * config.upgradeCost)} gems, ${atTarget} already at ≥${args.target} power, ` +
        `${unaffordable} cannot afford any, ${failed.length} failed`,
    );
  } else {
    console.log(
      `\nbought ${bought} upgrade(s) for ${upgraded.length}/${batch.length} wallet(s), ${gems(spent)} gems spent — ` +
        `${atTarget} at ≥${args.target} power, ${unaffordable} unaffordable, ${short} short of target, ` +
        `${failed.length} failed`,
    );
  }
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
