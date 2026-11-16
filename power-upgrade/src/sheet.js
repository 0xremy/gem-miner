import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";

/**
 * Read side of the sheet: each wallet's address, current token and proxy.
 * The token refresher owns writing tokens; this app never writes.
 */

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

/** Accepts a full Google Sheets URL or a bare spreadsheet id. */
export function sheetIdFrom(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("SHEET_ID is not set (use a …/spreadsheets/d/<id>/… link or the id)");
  const fromUrl = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (fromUrl) return fromUrl[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) return text;
  throw new Error(`SHEET_ID does not look like a Google Sheets link or id: ${text}`);
}

/** Resolves a relative credential path against this app, not the caller's cwd. */
function resolvePath(file) {
  if (!file.startsWith(".")) return file;
  return fileURLToPath(new URL(`../${file.replace(/^\.\//, "")}`, import.meta.url));
}

async function credentials() {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let parsed;
  if (inline) {
    parsed = JSON.parse(inline);
  } else {
    const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
    if (!file) {
      throw new Error(
        "No Google credentials: set GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON",
      );
    }
    parsed = JSON.parse(await readFile(resolvePath(file), "utf8"));
  }
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}

const quoteTab = (tab) => `'${tab.replace(/'/g, "''")}'`;

const normalize = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Finds the tab, the address/token/proxy columns, and every wallet row.
 *
 * @returns {{
 *   tab: string,
 *   rowsByAddress: Map<string, number>,
 *   namesByAddress: Map<string, string>,
 *   tokensByAddress: Map<string, string>,
 *   proxiesByAddress: Map<string, string>,
 *   locationsByAddress: Map<string, string>,
 *   gearsByAddress: Map<string, string>,
 * }}
 */
export async function readSheetIndex(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
  const tab = meta.data.sheets?.[0]?.properties?.title;
  if (!tab) throw new Error("the spreadsheet has no worksheet");

  const header = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteTab(tab)}!A1:Z1`,
  });
  const names = header.data.values?.[0] ?? [];

  let addressColumn = 0;
  let tokenColumn = 0;
  let proxyColumn = 0;
  let nameColumn = 0;
  let locationColumn = 0;
  let gearColumn = 0;
  names.forEach((cell, index) => {
    const key = normalize(cell);
    if (!addressColumn && ["walletaddress", "address"].includes(key)) addressColumn = index + 1;
    if (!tokenColumn && ["token", "bearer"].includes(key)) tokenColumn = index + 1;
    if (!proxyColumn && ["proxy", "proxies", "proxyurl"].includes(key)) proxyColumn = index + 1;
    if (!nameColumn && ["name", "profile", "wallet", "walletname"].includes(key)) nameColumn = index + 1;
    if (!locationColumn && ["location", "mine", "mininglocation"].includes(key)) locationColumn = index + 1;
    if (!gearColumn && ["gear", "loadout"].includes(key)) gearColumn = index + 1;
  });
  if (!addressColumn || !tokenColumn) {
    throw new Error(
      `tab "${tab}" needs "Wallet Address" and "Token" headers (found: ${names.join(" | ")})`,
    );
  }

  const values = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteTab(tab)}!A:Z`,
  });
  const rows = values.data.values ?? [];

  const rowsByAddress = new Map();
  const namesByAddress = new Map();
  const tokensByAddress = new Map();
  const proxiesByAddress = new Map();
  const locationsByAddress = new Map();
  const gearsByAddress = new Map();
  const cell = (row, column) => (column ? String(row[column - 1] ?? "").trim() : "");
  for (let i = 1; i < rows.length; i += 1) {
    const address = String(rows[i][addressColumn - 1] ?? "").trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
    rowsByAddress.set(address, i + 1);
    namesByAddress.set(address, cell(rows[i], nameColumn) || address.slice(0, 10));
    tokensByAddress.set(address, cell(rows[i], tokenColumn));
    proxiesByAddress.set(address, cell(rows[i], proxyColumn));
    locationsByAddress.set(address, cell(rows[i], locationColumn));
    gearsByAddress.set(address, cell(rows[i], gearColumn));
  }

  return {
    tab,
    rowsByAddress,
    namesByAddress,
    tokensByAddress,
    proxiesByAddress,
    locationsByAddress,
    gearsByAddress,
  };
}

export async function openSheets() {
  const parsed = await credentials();
  const auth = new google.auth.JWT({
    email: parsed.client_email,
    key: parsed.private_key,
    scopes: SCOPES,
  });
  return google.sheets({ version: "v4", auth });
}
