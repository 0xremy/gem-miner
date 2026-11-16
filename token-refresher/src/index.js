#!/usr/bin/env node
import { config } from "./config.js";
import { readSeedWorkbook, signerFor } from "./keys.js";
import { refreshToken, tokenExpiry } from "./auth.js";
import { openSheets, readSheetIndex, sheetIdFrom, writeTokens } from "./sheet.js";
import { parseProxy } from "./proxy.js";

/**
 * Refreshes every wallet's JWT from its seed phrase and writes the new tokens
 * into the Google Sheet, matched by wallet address.
 *
 *   npm run refresh                 → mint + write to the sheet
 *   npm run refresh -- --dry-run    → mint, print, write nothing
 *   npm run refresh -- --only 0x…   → one wallet, for a smoke test
 *   node src/index.js --expired-only → only wallets whose sheet token is dead
 *
 * Options: --keys <file> --sheet <id|url> --limit <n> --concurrency <n>
 */

const USAGE = `
Usage: node src/index.js [options]

  --keys <file>        seed workbook (3 columns: name, address, seed phrase)
  --sheet <id|url>     Google Sheet to update (defaults to SHEET_ID)
  --dry-run            mint tokens but do not write to the sheet
  --only <address>     only this wallet address
  --expired-only       skip wallets whose token in the sheet is still valid
  --no-proxy           ignore the sheet's Proxy column (uses your own IP)
  --limit <n>          stop after n wallets
  --concurrency <n>    parallel logins (default ${config.concurrency})
`;

function parseArgs(argv) {
  const args = { dryRun: false, only: null, expiredOnly: false, noProxy: false, limit: Infinity };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--keys") args.keys = next();
    else if (arg === "--sheet") args.sheet = next();
    else if (arg === "--only") args.only = next().trim().toLowerCase();
    else if (arg === "--expired-only") args.expiredOnly = true;
    else if (arg === "--no-proxy") args.noProxy = true;
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg === "--concurrency") args.concurrency = Math.max(1, Number(next()));
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

const describe = (expiresAt) => {
  if (!expiresAt) return "expiry unknown";
  const hours = (expiresAt - Date.now()) / 3600_000;
  return `${new Date(expiresAt).toISOString()} (${hours.toFixed(1)} h)`;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keysPath = args.keys ?? config.keysXlsx;
  const concurrency = args.concurrency ?? config.concurrency;

  const wallets = await readSeedWorkbook(keysPath);
  console.log(`seeds: ${wallets.length} row(s) from ${keysPath}`);

  const matched = wallets.filter(
    (wallet) => !args.only || wallet.address.trim().toLowerCase() === args.only,
  );
  if (matched.length === 0) throw new Error("no wallet rows matched");

  // The sheet is needed to know where each token goes.
  let sheets = null;
  let layout = null;
  let spreadsheetId = null;
  try {
    spreadsheetId = sheetIdFrom(args.sheet ?? config.sheetId);
    sheets = await openSheets();
    layout = await readSheetIndex(sheets, spreadsheetId);
    console.log(
      `sheet: tab "${layout.tab}", ${layout.rowsByAddress.size} address row(s) — tokens go to column ${layout.tokenColumn}`,
    );
    const withProxy = [...layout.proxiesByAddress.values()].filter(Boolean).length;
    console.log(`proxies: ${withProxy}/${layout.proxiesByAddress.size} row(s) have one`);
  } catch (error) {
    if (!args.dryRun) throw error;
    console.warn(`warning: cannot read the sheet (${error.message}) — dry run continues, nothing will be written`);
  }

  // --expired-only: the token already in the sheet decides, so no login is
  // spent on a wallet that is still good. A missing or unreadable token counts
  // as expired — that is exactly the case worth fixing.
  const stillValid = [];
  const targets = [];
  for (const wallet of matched) {
    const address = wallet.address.trim().toLowerCase();
    const current = args.expiredOnly ? tokenExpiry(layout?.tokensByAddress.get(address)) : null;
    if (current && current > Date.now()) stillValid.push({ wallet, address, expiresAt: current });
    else targets.push(wallet);
  }
  if (args.expiredOnly && !layout) {
    throw new Error("--expired-only has to read the sheet to see which tokens expired, but it is unavailable");
  }

  if (stillValid.length && args.only) {
    const entry = stillValid[0];
    console.log(
      `· ${entry.wallet.name} ${entry.address} still valid until ${describe(entry.expiresAt)} — skipped`,
    );
  } else if (stillValid.length) {
    console.log(`· ${stillValid.length} wallet(s) still have valid tokens — skipped`);
  }

  const batch = targets.slice(0, args.limit);
  if (batch.length === 0) {
    console.log(`nothing to refresh: all ${matched.length} matched wallet(s) still have valid tokens`);
    return;
  }

  const outcome = await mapPool(batch, concurrency, async (wallet) => {
    const address = wallet.address.trim().toLowerCase();
    try {
      const { signer, path } = signerFor(wallet, { limit: config.derivationLimit });
      const row = layout?.rowsByAddress.get(address) ?? null;

      if (!row && !args.dryRun) {
        throw new Error("address is not in the sheet — row skipped");
      }

      // Each login leaves from that wallet's own proxy IP: Cloudflare throttles
      // per IP, so a few hundred logins from one address end in 429s.
      let proxy = args.noProxy ? null : parseProxy(layout?.proxiesByAddress.get(address));
      const token = await refreshToken({ address, signer, proxy });
      return { wallet, address, row, token, path, proxy, expiresAt: tokenExpiry(token) };
    } catch (error) {
      return { wallet, address, error };
    }
  });

  const minted = outcome.filter((entry) => entry.token);
  const failed = outcome.filter((entry) => entry.error);

  for (const entry of outcome) {
    if (entry.error) {
      console.log(`✗ ${entry.wallet.name} ${entry.address}: ${entry.error.message}`);
    } else {
      const where = entry.row ? `row ${entry.row}` : "not in sheet";
      const via = entry.proxy ? `via ${entry.proxy.label}` : "direct";
      console.log(
        `✓ ${entry.wallet.name} ${entry.address} [${entry.path}] → ${where}, valid until ${describe(entry.expiresAt)}, ${via}`,
      );
    }
  }

  const updates = minted
    .filter((entry) => entry.row)
    .map(({ address, row, token }) => ({ address, row, token }));

  if (args.dryRun) {
    console.log(`\ndry run: ${minted.length} token(s) minted, 0 written`);
  } else {
    const written = await writeTokens(sheets, spreadsheetId, layout, updates);
    console.log(`\nwrote ${written} token(s) to the sheet`);
  }

  const skipped = stillValid.length ? `, skipped ${stillValid.length} still-valid` : "";
  const proxied = minted.filter((entry) => entry.proxy).length;
  const direct = minted.length - proxied;
  console.log(
    `minted ${minted.length}/${batch.length}${skipped}, failed ${failed.length} — ${proxied} via proxy, ${direct} direct`,
  );
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
