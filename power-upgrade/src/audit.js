#!/usr/bin/env node
import ExcelJS from "exceljs";
import { config } from "./config.js";
import { createClient } from "./api.js";
import { openSheets, readSheetIndex, sheetIdFrom } from "./sheet.js";
import { parseProxy } from "./proxy.js";
import { readInventory } from "./inventory.js";

/**
 * Checks every wallet in the sheet for a shop item and writes an .xlsx report,
 * so the wallets that have not bought it are visible in one place.
 *
 *   GET /api/user/inventory → [ { assetId: "mine-cart-1", quantity: 1, … } ]
 *
 *   node src/audit.js                  → mine-cart-audit.xlsx in the current directory
 *   node src/audit.js --out report.xlsx
 *   node src/audit.js --limit 10       → only the first ten wallets
 *
 * Read-only: nothing is bought here. To buy for the wallets the report marks
 * "not purchased", run `node src/buy.js` — it checks the same inventory and only
 * charges wallets that do not own the item.
 */

const USAGE = `
Usage: node src/audit.js [options]

  --item <id>          shop item to check (default ${config.shopItemId})
  --price <gems>       price used for the "can afford" column (default ${config.shopItemPrice})
  --out <file>         report path (default mine-cart-audit.xlsx)
  --only <addresses>   only these wallet addresses (comma separated)
  --limit <n>          stop after n wallets
  --no-proxy           ignore the sheet's Proxy column (uses your own IP)
  --fallback-direct    retry a wallet whose proxy fails over your own IP (read-only)
  --concurrency <n>    parallel wallets (default ${config.concurrency})
`;

function parseArgs(argv) {
  const args = {
    only: null,
    noProxy: false,
    fallbackDirect: false,
    limit: Infinity,
    item: config.shopItemId,
    price: config.shopItemPrice,
    out: "mine-cart-audit.xlsx",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--only") args.only = next().split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    else if (arg === "--no-proxy") args.noProxy = true;
    else if (arg === "--fallback-direct") args.fallbackDirect = true;
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg === "--concurrency") args.concurrency = Math.max(1, Number(next()));
    else if (arg === "--item") args.item = next().trim();
    else if (arg === "--price") args.price = Number(next());
    else if (arg === "--out") args.out = next().trim();
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

const HEADER = [
  "#",
  "Name",
  "Wallet Address",
  "Owns item",
  "Quantity",
  "Gems",
  "Can afford",
  "Proxy",
  "Note",
];

async function writeReport(path, rows, { itemId, price }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "gem-miner";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Inventory check", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { key: "index", width: 6 },
    { key: "name", width: 24 },
    { key: "address", width: 46 },
    { key: "owns", width: 12 },
    { key: "quantity", width: 10 },
    { key: "gems", width: 14 },
    { key: "afford", width: 12 },
    { key: "proxy", width: 34 },
    { key: "note", width: 44 },
  ];

  const header = sheet.addRow(HEADER);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
  header.alignment = { vertical: "middle" };
  sheet.autoFilter = { from: "A1", to: `I${1}` };

  const FILL = {
    owned: { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2F0D9" } },
    missing: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFBE5E5" } },
    failed: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } },
  };

  rows.forEach((row, index) => {
    const state = row.error ? "failed" : row.quantity > 0 ? "owned" : "missing";
    const entry = sheet.addRow({
      index: index + 1,
      name: row.name,
      address: row.address,
      owns: row.error ? "check failed" : row.quantity > 0 ? "yes" : "no",
      quantity: row.error ? "" : row.quantity,
      gems: Number.isFinite(row.gems) ? row.gems : "",
      afford: row.error
        ? ""
        : Number.isFinite(row.gems)
          ? row.gems >= price
            ? "yes"
            : "no"
          : "",
      proxy: row.proxy?.label ?? "direct",
      note: row.error ?? row.note ?? "",
    });
    entry.getCell(4).fill = FILL[state];
    entry.getCell(4).font = { bold: true };
    entry.getCell(6).numFmt = "#,##0";
    entry.getCell(7).fill = FILL[state];
    if (row.error) entry.getCell(9).font = { color: { argb: "FFC00000" } };
  });

  sheet.getRow(1).eachCell((cell) => {
    cell.border = { bottom: { style: "thin", color: { argb: "FF9BA7B4" } } };
  });

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { key: "label", width: 40 },
    { key: "value", width: 16 },
  ];
  const owned = rows.filter((row) => !row.error && row.quantity > 0).length;
  const missing = rows.filter((row) => !row.error && row.quantity === 0);
  const failed = rows.filter((row) => row.error);
  const affordable = missing.filter((row) => Number.isFinite(row.gems) && row.gems >= price).length;
  summary.addRows([
    { label: "Item", value: `${itemId} (${gems(price)} gems)` },
    { label: "Checked", value: rows.length },
    { label: "Purchased", value: owned },
    { label: "Not purchased", value: missing.length },
    { label: `Not purchased but can afford`, value: affordable },
    { label: "Check failed", value: failed.length },
    { label: "Generated", value: new Date().toISOString() },
  ]);
  summary.getColumn(1).font = { bold: true };

  await workbook.xlsx.writeFile(path);
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
  console.log(`wallets: ${batch.length}, ${withProxy} with a proxy`);
  console.log(`checking ${args.item} ownership via /api/user/inventory — nothing is bought\n`);

  const rows = await mapPool(batch, args.concurrency ?? config.concurrency, async (address) => {
    const name = layout.namesByAddress.get(address) ?? address.slice(0, 10);
    const token = layout.tokensByAddress.get(address);
    let proxy = null;
    const check = async (client, proxyLabel) => {
      const { quantity } = await readInventory(client, args.item);
      let walletGems = null;
      let note = proxyLabel;
      try {
        walletGems = Number(await client.balance().then((balance) => balance?.gems));
        if (!Number.isFinite(walletGems)) walletGems = null;
      } catch (error) {
        note = `${proxyLabel ?? ""} balance read failed: ${error.message}`.trim();
      }
      return { quantity, walletGems, note };
    };

    try {
      if (!token) throw new Error("no token in the sheet — run the token refresher first");
      proxy = args.noProxy ? null : parseProxy(layout.proxiesByAddress.get(address));

      let result;
      try {
        result = await check(createClient({ token, address, proxy }));
      } catch (error) {
        if (!args.fallbackDirect || !proxy) throw error;
        console.log(`~ ${name} ${address}: proxy ${proxy.label} failed, retrying direct`);
        result = await check(
          createClient({ token, address, proxy: null }),
          `direct fallback — proxy ${proxy.label} failed: ${error.message}`,
        );
      }

      const { quantity, walletGems, note } = result;
      if (quantity > 0) console.log(`✓ ${name} ${address}: owns ${args.item} ×${quantity}`);
      else console.log(`· ${name} ${address}: no ${args.item}${walletGems !== null ? ` (gems ${gems(walletGems)})` : ""}`);
      return { name, address, quantity, gems: walletGems, proxy, note };
    } catch (error) {
      const hint = error.status === 401 ? " (token expired — run the token refresher)" : "";
      console.log(`✗ ${name} ${address}: ${error.message}${hint}`);
      return { name, address, quantity: 0, gems: null, proxy, error: error.message + hint };
    }
  });

  await writeReport(args.out, rows, { itemId: args.item, price: args.price });

  const owned = rows.filter((row) => !row.error && row.quantity > 0).length;
  const missing = rows.filter((row) => !row.error && row.quantity === 0).length;
  const failed = rows.filter((row) => row.error).length;
  console.log(
    `\nchecked ${rows.length}: ${owned} own ${args.item}, ${missing} do not, ${failed} failed`,
  );
  console.log(`report: ${args.out}`);
  if (missing) console.log(`buy for the ${missing} without it: node src/buy.js`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
