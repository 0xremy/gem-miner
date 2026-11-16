#!/usr/bin/env node
import { config } from "./config.js";
import { createClient } from "./api.js";
import { openSheets, readSheetIndex, sheetIdFrom } from "./sheet.js";
import { parseProxy } from "./proxy.js";
import { upgradeWallet } from "./upgrade.js";
import { buyItems, loadCatalog } from "./shop.js";
import { upgradeEnergy } from "./energy.js";
import { runCheckins } from "./quests.js";
import { DEFAULT_MINE, STRATEGY, resolveMine, runMining, VEINS_PER_MINE } from "./mining.js";

/**
 * Buys Mining Power I for every wallet in the sheet until its mining power
 * reaches TARGET_POWER (default 62: +5 per purchase from 2).
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
  --quests             daily + weekly check-in for every wallet (no buying)
  --mine               claim finished veins, then keep all 6 veins of the
                       sheet's Location mine digging with the "deep" strategy

Shop mode (buys items instead of the power upgrade):

  --items <ids>        comma-separated shop item ids, e.g. iron-pickaxe,iron-drill
  --count <n>          how many of each item per wallet (default 1)
  --list-items         print the shop catalog and exit
`;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    only: null,
    noProxy: false,
    limit: Infinity,
    target: config.targetPower,
    items: null,
    count: 1,
    listItems: false,
    energy: false,
    quests: false,
    mine: false,
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
    else if (arg === "--items")
      args.items = next()
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    else if (arg === "--count") args.count = Math.max(1, Number(next()));
    else if (arg === "--list-items") args.listItems = true;
    else if (arg === "--energy") args.energy = true;
    else if (arg === "--quests") args.quests = true;
    else if (arg === "--mine") args.mine = true;
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

/** One wallet's check-in result, printed as soon as it finishes. */
function reportCheckin(entry, proxy) {
  const via = proxy ? `, via ${proxy.label}` : "";
  const parts = entry.results.map((quest) =>
    quest.status === "claimed" && quest.gems > 0
      ? `${quest.label.toLowerCase()} +${quest.gems}`
      : `${quest.label.toLowerCase()} ${quest.note || quest.status}`,
  );
  const trail = `+${entry.gems} gems${via}`;
  const broken = entry.results.filter((quest) => quest.status === "error");
  if (broken.length) {
    console.log(`✗ ${entry.name} ${entry.address}: ${parts.join(", ")}`);
  } else if (entry.claimed > 0) {
    console.log(`✓ ${entry.name} ${entry.address}: ${parts.join(", ")} — ${trail}`);
  } else {
    console.log(`= ${entry.name} ${entry.address}: ${parts.join(", ")}${via}`);
  }
}

/** One wallet's mining pass, printed as soon as it finishes. */
function reportMine(entry, proxy) {
  const via = proxy ? `, via ${proxy.label}` : "";
  const claims = entry.claims
    ? entry.dryRun
      ? `${entry.claims} finished vein(s) to claim`
      : `claimed ${entry.claims} (+${gems(entry.gems)} gems)`
    : "no finished veins";
  const veins = `${entry.mineLabel}: ${entry.veins}/${entry.total} veins ${
    entry.dryRun ? "would dig" : "digging"
  }`;
  const spill = entry.spill.length
    ? `, +${entry.spill.reduce((sum, lower) => sum + lower.started, 0)} lower-rank vein(s)`
    : "";
  const energy = `energy ${gems(entry.energyStart)} → ${gems(entry.energyEnd)}`;
  const notes = entry.notes.length ? ` — ${entry.notes.join("; ")}` : "";
  if (!entry.complete) {
    console.log(
      `⚠ ${entry.name} ${entry.address}: ${claims}, ${veins} — waiting for the next loop (${energy})${spill}${notes}${via}`,
    );
  } else if (entry.started > 0 || entry.claims > 0) {
    console.log(
      `✓ ${entry.name} ${entry.address}: ${claims}, ${veins}${spill} — ${energy}${notes}${via}`,
    );
  } else {
    console.log(`= ${entry.name} ${entry.address}: ${claims}, ${veins} — ${energy}${notes}${via}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const concurrency = args.concurrency ?? config.concurrency;

  if (args.listItems) {
    const catalog = await loadCatalog();
    for (const item of catalog) {
      const power = item.effect?.miningPower;
      console.log(
        `${item.id.padEnd(20)} ${String(item.price).padStart(6)} gems  ${item.name}` +
          (Number.isFinite(power) ? ` (+${power} power)` : ""),
      );
    }
    return;
  }

  const spreadsheetId = sheetIdFrom(config.sheetId);
  const sheets = await openSheets();
  const layout = await readSheetIndex(sheets, spreadsheetId);
  console.log(
    `sheet: tab "${layout.tab}", ${layout.rowsByAddress.size} wallet row(s)` +
      (args.energy || args.quests || args.mine ? "" : `, target ${args.target} power`),
  );

  let addresses = [...layout.rowsByAddress.keys()];
  if (args.only) addresses = addresses.filter((address) => address === args.only);
  if (addresses.length === 0) throw new Error("no wallet rows matched");

  const batch = addresses.slice(0, args.limit);
  const withProxy = batch.filter((address) => layout.proxiesByAddress.get(address)).length;
  console.log(
    `wallets: ${batch.length}${args.only ? "" : ` of ${addresses.length}`}, ${withProxy} with a proxy`,
  );
  if (args.dryRun && !args.quests && !args.mine)
    console.log("dry run: balances are read, no gems are spent\n");

  const modes = [args.quests, args.mine, Boolean(args.items), args.energy].filter(Boolean).length;
  if (modes > 1) throw new Error("pick one mode: --quests, --mine, --items or --energy");

  if (args.quests) {
    console.log("check-in: daily_miner_signin + weekly_miner_checkin, start → wait → claim\n");

    const results = await mapPool(batch, concurrency, async (address) => {
      const name = layout.namesByAddress.get(address) ?? address.slice(0, 10);
      const token = layout.tokensByAddress.get(address);
      let proxy = null;
      try {
        if (!token) throw new Error("no token in the sheet — run the token refresher first");
        proxy = args.noProxy ? null : parseProxy(layout.proxiesByAddress.get(address));
        const client = createClient({ token, address, proxy });
        const record = await runCheckins({ name, address, client, dryRun: args.dryRun });
        reportCheckin(record, proxy);
        return { ...record, proxy };
      } catch (error) {
        const hint = error.status === 401 ? " (token expired — run the token refresher)" : "";
        const via = proxy ? `, via ${proxy.label}` : "";
        console.log(`✗ ${name} ${address}: ${error.message}${hint}${via}`);
        return { name, address, proxy, error };
      }
    });

    const done = results.filter((entry) => !entry.error);
    // Only quests collected in this run count; "already claimed" pays nothing.
    const earnedOne = (entry, id, status) =>
      entry.results.some((q) => q.id === id && q.status === status && q.gems > 0);
    const daily = done.filter((entry) => earnedOne(entry, "daily_miner_signin", "claimed")).length;
    const weekly = done.filter((entry) => earnedOne(entry, "weekly_miner_checkin", "claimed")).length;
    const claimable = (id) =>
      done.filter((entry) => entry.results.some((q) => q.id === id && q.status === "available")).length;
    const earned = done.reduce((sum, entry) => sum + entry.gems, 0);
    const failed = results.length - done.length;
    if (args.dryRun) {
      console.log(
        `\ndry run: ${claimable("daily_miner_signin")} daily and ${claimable("weekly_miner_checkin")} weekly ` +
          `check-in(s) claimable, nothing claimed, ${failed} failed`,
      );
    } else {
      console.log(
        `\n${daily} daily + ${weekly} weekly check-in(s) claimed, +${gems(earned)} gems, ${failed} failed`,
      );
    }
    if (failed) process.exitCode = 1;
    return;
  }

  if (args.mine) {
    console.log(
      `mining: claim finished veins, then start "${STRATEGY}" on all 6 veins of the sheet's Location mine` +
        ` — lower-rank mines only while energy is left\n`,
    );

    const results = await mapPool(batch, concurrency, async (address) => {
      const name = layout.namesByAddress.get(address) ?? address.slice(0, 10);
      const token = layout.tokensByAddress.get(address);
      const sheetMine = layout.locationsByAddress.get(address) ?? "";
      const mine = resolveMine(sheetMine) ?? DEFAULT_MINE;
      const gear = layout.gearsByAddress.get(address) || null;
      let proxy = null;
      try {
        if (!token) throw new Error("no token in the sheet — run the token refresher first");
        proxy = args.noProxy ? null : parseProxy(layout.proxiesByAddress.get(address));
        const client = createClient({ token, address, proxy });
        const record = await runMining({ name, address, client, mine, gear, dryRun: args.dryRun });
        if (sheetMine && !resolveMine(sheetMine)) record.notes.push(`sheet mine "${sheetMine}" not recognised`);
        reportMine(record, proxy);
        return { ...record, proxy };
      } catch (error) {
        const hint = error.status === 401 ? " (token expired — run the token refresher)" : "";
        const via = proxy ? `, via ${proxy.label}` : "";
        console.log(`✗ ${name} ${address}: ${error.message}${hint}${via}`);
        return { name, address, proxy, error };
      }
    });

    const done = results.filter((entry) => !entry.error);
    const armed = done.reduce((sum, entry) => sum + entry.started, 0);
    const claimed = done.reduce((sum, entry) => sum + entry.claims, 0);
    const earned = done.reduce((sum, entry) => sum + entry.gems, 0);
    const full = done.filter((entry) => entry.complete).length;
    const spilled = done.reduce(
      (sum, entry) => sum + entry.spill.reduce((lower, item) => lower + item.started, 0),
      0,
    );
    const dry = done.filter((entry) => entry.outOfEnergy).length;
    const failed = results.length - done.length;
    console.log(
      args.dryRun
        ? `\nwould arm ${armed} ${STRATEGY} vein(s) for ${done.length}/${batch.length} wallet(s) — ` +
            `${full} with all ${VEINS_PER_MINE} appointed veins going, ${spilled} lower-rank vein(s), ` +
            `${claimed} claimable, ${dry} out of energy, ${failed} failed`
        : `\n${armed} ${STRATEGY} vein(s) armed for ${done.length}/${batch.length} wallet(s) — ` +
            `${full} with all ${VEINS_PER_MINE} appointed veins digging, ${spilled} lower-rank vein(s), ` +
            `${claimed} claimed (+${gems(earned)} gems), ${dry} out of energy, ${failed} failed`,
    );
    if (failed) process.exitCode = 1;
    return;
  }

  if (args.items && args.energy) throw new Error("pick either --items or --energy, not both");
  if (args.energy) {
    console.log(
      `energy: ${config.energyUpgradeId} (+${config.energyIncrement} capacity) — buy until the API refuses; ` +
        `each price is read from the live response, never assumed\n`,
    );
  }

  let catalog = null;
  if (args.items) {
    catalog = await loadCatalog();
    const unknown = args.items.filter((id) => !catalog.some((item) => item.id === id));
    if (unknown.length) {
      throw new Error(`unknown shop item(s): ${unknown.join(", ")} — run --list-items to see the catalog`);
    }
    const detail = args.items
      .map((id) => {
        const item = catalog.find((entry) => entry.id === id);
        return `${id} (${item.price} gems)${args.count > 1 ? ` ×${args.count}` : ""}`;
      })
      .join(", ");
    console.log(`shop: ${detail}\n`);
  }

  const outcome = await mapPool(batch, concurrency, async (address) => {
    const name = layout.namesByAddress.get(address) ?? address.slice(0, 10);
    const token = layout.tokensByAddress.get(address);
    let proxy = null;
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
        : args.items
        ? await buyItems({
            name,
            address,
            client,
            catalog,
            itemIds: args.items,
            count: args.count,
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
      const entry = { ...record, proxy, energy: args.energy };
      reportLine(entry);
      return entry;
    } catch (error) {
      const entry = { name, address, proxy, error };
      reportLine(entry);
      return entry;
    }
  });

  // Prints one wallet as soon as it finishes, so a long run is watchable.
  function reportLine(entry) {
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
    if (entry.items) {
      const parts = [];
      for (const item of entry.items) {
        if (entry.dryRun && item.planned > 0) parts.push(`${item.planned}× ${item.id}`);
        else if (item.bought > 0) parts.push(`${item.bought}× ${item.id}`);
        if (item.owned) parts.push(`${item.id} (already owned)`);
      }
      const list = parts.join(", ");
      const shopTrail = `gems ${gems(entry.startGems)} → ${gems(entry.endGems)}${
        entry.startPower === null ? "" : `, power ${entry.startPower} → ${entry.endPower}`
      }${via}`;
      if (entry.buyError) {
        console.log(`✗ ${entry.name} ${entry.address}: ${entry.buyError} (${entry.bought} bought, ${shopTrail})`);
      } else if (!list) {
        console.log(`⚠ ${entry.name} ${entry.address}: cannot afford any — ${shopTrail}`);
      } else if (entry.dryRun) {
        console.log(`· ${entry.name} ${entry.address}: would buy ${list} — ${shopTrail}`);
      } else {
        console.log(`✓ ${entry.name} ${entry.address}: ${list}, ${shopTrail}`);
      }
      return;
    }
    if (entry.buyError) {
      console.log(`✗ ${entry.name} ${entry.address}: ${entry.buyError} (${entry.bought} bought, ${trail})`);
    } else if (entry.verified && entry.endPower < args.target) {
      console.log(
        `⚠ ${entry.name} ${entry.address}: ${trail} — ${entry.bought}/${entry.needed} bought, ${entry.endPower - entry.startPower} power short of ${args.target}`,
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

  const done = outcome.filter((entry) => !entry.error);
  const failed = outcome.filter((entry) => entry.error || entry.buyError);
  const bought = done.reduce((sum, entry) => sum + entry.bought, 0);
  const spent = done.reduce((sum, entry) => sum + Math.max(0, entry.startGems - entry.endGems), 0);
  const planned = done.reduce((sum, entry) => sum + entry.count, 0);
  const upgraded = done.filter((entry) => (args.dryRun ? entry.count > 0 : entry.bought > 0));
  const atTarget = done.filter((entry) => entry.endPower >= args.target).length;
  const unaffordable = done.filter((entry) => entry.needed > 0 && entry.count === 0).length;
  const short = done.filter((entry) => entry.bought > 0 && entry.endPower < args.target).length;

  if (args.items) {
    const plannedItems = done.reduce((sum, entry) => sum + entry.planned, 0);
    const ownedItems = done.reduce(
      (sum, entry) => sum + entry.items.filter((item) => item.owned).length,
      0,
    );
    const shoppers = done.filter(
      (entry) => entry.bought > 0 || entry.items.some((item) => item.owned) || entry.planned > 0,
    );
    const nothing = done.length - shoppers.length;
    if (args.dryRun) {
      console.log(
        `\nwould buy ${plannedItems} item(s) for ${shoppers.length}/${batch.length} wallet(s) — ` +
          `~${gems(spent)} gems, ${nothing} cannot afford any, ${failed.length} failed`,
      );
    } else {
      console.log(
        `\nbought ${bought} item(s) for ${shoppers.length}/${batch.length} wallet(s), ${gems(spent)} gems spent — ` +
          `${ownedItems} already owned, ${nothing} could not buy, ${failed.length} failed`,
      );
    }
  } else if (args.energy && args.dryRun) {
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
