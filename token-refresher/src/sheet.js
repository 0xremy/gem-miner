import { readFile } from "node:fs/promises";
import { google } from "googleapis";

/**
 * Write-back side of the refresher.
 *
 * The sheet is the source of truth for the miner app, which re-downloads it at
 * every run — so a refreshed token is only useful once it is in the sheet.
 * Rows are located by wallet address (case-insensitive), never by position, so
 * reordering or inserting rows cannot put a token on the wrong wallet.
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

/** Service-account credentials, passed as an object (not the deprecated keyFilename). */
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
    parsed = JSON.parse(await readFile(file, "utf8"));
  }
  // Inline JSON often carries the private key with escaped newlines.
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}

const quoteTab = (tab) => `'${tab.replace(/'/g, "''")}'`;

const columnLetter = (n) => {
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

const normalize = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Finds the tab, the address column, the token column, and the row of every
 * wallet address currently in the sheet.
 *
 * @returns {{
 *   tab: string,
 *   tokenColumn: string,
 *   rowsByAddress: Map<string, number>,
 *   tokensByAddress: Map<string, string>,
 *   proxiesByAddress: Map<string, string>,
 * }}
 */
export async function readSheetIndex(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
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
  names.forEach((cell, index) => {
    const key = normalize(cell);
    if (!addressColumn && ["walletaddress", "address"].includes(key)) addressColumn = index + 1;
    if (!tokenColumn && ["token", "bearer"].includes(key)) tokenColumn = index + 1;
    if (!proxyColumn && ["proxy", "proxies", "proxyurl"].includes(key)) proxyColumn = index + 1;
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
  const tokensByAddress = new Map();
  const proxiesByAddress = new Map();
  for (let i = 1; i < rows.length; i += 1) {
    const address = String(rows[i][addressColumn - 1] ?? "").trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(address)) {
      rowsByAddress.set(address, i + 1); // +1: header
      tokensByAddress.set(address, String(rows[i][tokenColumn - 1] ?? "").trim());
      proxiesByAddress.set(address, String(rows[i][proxyColumn - 1] ?? "").trim());
    }
  }

  return {
    tab,
    tokenColumn: columnLetter(tokenColumn),
    rowsByAddress,
    tokensByAddress,
    proxiesByAddress,
  };
}

/**
 * Writes many tokens in one call.
 *
 * @param {{ address: string, row: number, token: string }[]} updates
 */
export async function writeTokens(sheets, spreadsheetId, { tab, tokenColumn }, updates) {
  if (updates.length === 0) return 0;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: updates.map(({ row, token }) => ({
        range: `${quoteTab(tab)}!${tokenColumn}${row}`,
        values: [[token]],
      })),
    },
  });

  return updates.length;
}

export async function openSheets() {
  const parsed = await credentials();
  // Build the JWT client directly: GoogleAuth's `credentials`/`keyFilename`
  // options are deprecated and log a warning on every run.
  const auth = new google.auth.JWT({
    email: parsed.client_email,
    key: parsed.private_key,
    scopes: SCOPES,
  });
  return google.sheets({ version: "v4", auth });
}
