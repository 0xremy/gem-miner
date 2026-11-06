import ExcelJS from "exceljs";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProxy } from "./proxy.js";
import { MINES, resolveLocation, describeMine, DEFAULT_LOCATION } from "./mines.js";

const legacyXlsxPath = fileURLToPath(new URL("../wallets.xlsx", import.meta.url));
const uploadedXlsxPath = fileURLToPath(new URL("../data/wallets.xlsx", import.meta.url));
const jsonPath = fileURLToPath(new URL("../wallets.json", import.meta.url));

/**
 * Which sheet is in use: WALLETS_FILE, else the uploaded copy in data/, else the
 * repo-root file used by local runs. Deployments never ship a sheet; you upload
 * it from the dashboard and it lands in data/wallets.xlsx.
 */
export function walletsFilePath() {
  if (process.env.WALLETS_FILE) return resolve(process.env.WALLETS_FILE);
  if (existsSync(uploadedXlsxPath)) return uploadedXlsxPath;
  if (existsSync(legacyXlsxPath)) return legacyXlsxPath;
  return uploadedXlsxPath;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/** Sheet headers → wallet fields, matched leniently ("Wallet Address" = "walletaddress"). */
const COLUMNS = {
  name: "label",
  label: "label",
  walletaddress: "address",
  address: "address",
  token: "token",
  bearer: "token",
  proxy: "proxy",
  location: "location",
  mine: "location",
  socialdaily: "socialDaily",
};

const normalize = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Reads the `exp` claim (seconds) out of a JWT without verifying it. */
function tokenExpiry(token) {
  try {
    const [, payload] = token.split(".");
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function entriesFromWorkbook(workbook) {
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("the sheet has no worksheet");

  const at = {};
  sheet.getRow(1).eachCell((cell, column) => {
    const field = COLUMNS[normalize(cell.text)];
    if (field) at[field] = column;
  });
  for (const required of ["address", "token"]) {
    if (!at[required]) {
      throw new Error(`wallets.xlsx is missing the "${required}" column`);
    }
  }

  const entries = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const pick = (field) => (at[field] ? row.getCell(at[field]).text.trim() : "");
    entries.push({
      row: r,
      label: pick("label"),
      address: pick("address"),
      token: pick("token"),
      proxy: pick("proxy"),
      location: pick("location"),
      socialDaily: pick("socialDaily"),
      socialDailyColumn: Boolean(at.socialDaily),
    });
  }
  return entries;
}

async function readSheet(path = walletsFilePath()) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  return entriesFromWorkbook(workbook);
}

/** Validates an uploaded .xlsx buffer without touching the current sheet. */
export async function inspectXlsxBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS accepts a Buffer directly for in-memory workbooks.
  await workbook.xlsx.load(buffer);
  const { wallets, skipped } = collect(await entriesFromWorkbook(workbook), { quiet: true });
  return { count: wallets.length, skipped };
}

function readJson() {
  let raw;
  try {
    raw = readFileSync(jsonPath, "utf8");
  } catch {
    throw new Error(
      "No wallets found. Add rows to wallets.xlsx (or copy wallets.example.json to wallets.json).",
    );
  }
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.wallets;
  if (!Array.isArray(list)) throw new Error("wallets.json must be an array or { wallets: [...] }");
  return list.map((wallet, index) => ({
    row: index + 2,
    label: wallet.label ?? "",
    address: wallet.address ?? "",
    token: wallet.token ?? "",
    proxy: wallet.proxy ?? "",
    location: wallet.locationId ?? wallet.location ?? "",
    socialDaily: wallet.socialDaily === false ? "" : "x",
    socialDailyColumn: wallet.socialDaily !== undefined,
  }));
}

function buildWallet(entry, position) {
  const label = entry.label || `wallet-${position + 1}`;
  if (!ADDRESS_RE.test(entry.address)) {
    return { skip: `${label} (row ${entry.row}): wallet address is not a 0x… address` };
  }
  if (!JWT_RE.test(entry.token)) {
    return { skip: `${label} (row ${entry.row}): token does not look like a bearer JWT` };
  }

  let proxy = null;
  try {
    proxy = parseProxy(entry.proxy);
  } catch (error) {
    return { skip: `${label} (row ${entry.row}): ${error.message}` };
  }

  const warn = [];

  // Optional: which mine this wallet works. Blank falls back to the default
  // (greenstone-quarry); the number of sessions always comes from the balance.
  let locationId = null;
  if (entry.location) {
    locationId = resolveLocation(entry.location);
    if (!locationId) {
      warn.push(
        `${label} (row ${entry.row}): unknown mine "${entry.location}" — use ${MINES.map((m) => m.id).join(", ")}; falling back to the default`,
      );
    }
  }

  const expiresAt = tokenExpiry(entry.token);
  return {
    wallet: {
      label,
      walletAddress: entry.address.toLowerCase(),
      token: entry.token,
      proxy,
      locationId,
      // "x" in the Social Daily column = run the social daily quest for this
      // wallet. Blank skips it. A sheet without that column at all keeps the
      // old behaviour (every wallet runs it).
      socialDaily: entry.socialDailyColumn ? /^x+$/i.test(entry.socialDaily) : true,
      expiresAt,
      expired: expiresAt !== null && expiresAt <= Date.now(),
    },
    warn,
  };
}

/** Turns raw sheet rows into wallet objects plus skip/warning notes. */
function collect(entries, { quiet }) {
  const wallets = [];
  const skipped = [];
  const warnings = [];

  entries.forEach((entry, index) => {
    // Ignore untouched rows (the template's greyed-out example, blank lines).
    if (!entry.address && !entry.token && !entry.proxy) return;
    const built = buildWallet(entry, index);
    if (built.skip) skipped.push(built.skip);
    else {
      wallets.push(built.wallet);
      warnings.push(...built.warn);
    }
  });

  if (!quiet) {
    for (const note of skipped) console.warn(`skipped: ${note}`);
    for (const note of warnings) console.warn(`warning: ${note}`);

    const byProxy = new Map();
    for (const wallet of wallets) {
      if (!wallet.proxy) continue;
      byProxy.set(wallet.proxy.label, [...(byProxy.get(wallet.proxy.label) ?? []), wallet.label]);
    }
    for (const [host, labels] of byProxy) {
      if (labels.length > 1) {
        console.warn(`warning: ${labels.join(", ")} share proxy ${host} — they will not have unique IPs`);
      }
    }
    const direct = wallets.filter((wallet) => !wallet.proxy).map((wallet) => wallet.label);
    if (direct.length) {
      const verb = direct.length === 1 ? "has" : "have";
      console.warn(`warning: ${direct.join(", ")} ${verb} no proxy and will use your own IP`);
    }
  }

  return { wallets, skipped, warnings };
}

let cached;

export async function loadWallets({ quiet = false, fresh = false } = {}) {
  if (cached && !fresh) return cached;

  const path = walletsFilePath();
  const entries = existsSync(path) ? await readSheet(path) : readJson();
  const { wallets, skipped } = collect(entries, { quiet });

  if (wallets.length === 0) {
    throw new Error(
      `No valid wallets in ${path}. Upload wallets.xlsx from the dashboard, or fill in a row with address and token.`,
    );
  }

  cached = wallets;
  return cached;
}

export function describeExpiry(wallet) {
  if (!wallet.expiresAt) return "token expiry unknown";
  return wallet.expired
    ? "TOKEN EXPIRED"
    : `token valid until ${new Date(wallet.expiresAt).toISOString()}`;
}

export function describeProxy(wallet) {
  return wallet.proxy ? `via ${wallet.proxy.label}` : "direct (own IP)";
}

/** The mine a wallet is configured for in the sheet, if any. */
export function describeMining(wallet) {
  return wallet.locationId
    ? describeMine(wallet.locationId)
    : `default (${describeMine(DEFAULT_LOCATION)})`;
}
