import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The wallet sheet can come from a Google Sheet instead of an upload. Set
 * WALLETS_SHEET_URL (normal ".../edit?usp=sharing" link, or a direct export
 * link) or WALLETS_SHEET_ID, and every run downloads a fresh .xlsx before it
 * reads the wallets — so edits made in Google are picked up without a restart.
 *
 * The download is cached as data/wallets.xlsx, which is also what the upload
 * button writes, so a failed download falls back to the last copy on disk.
 */
const cachedXlsxPath = fileURLToPath(new URL("../data/wallets.xlsx", import.meta.url));

const SHEET_ID_RE = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;
const BARE_ID_RE = /^[a-zA-Z0-9_-]{20,}$/;

/** Export URL for the configured sheet, or null when no sheet is configured. */
export function sheetExportUrl() {
  const configured = (process.env.WALLETS_SHEET_URL || process.env.WALLETS_SHEET_ID || "").trim();
  if (!configured) return null;

  if (BARE_ID_RE.test(configured)) {
    return `https://docs.google.com/spreadsheets/d/${configured}/export?format=xlsx`;
  }

  const id = configured.match(SHEET_ID_RE)?.[1];
  if (!id) {
    throw new Error(
      "WALLETS_SHEET_URL must be a Google Sheet link (…/spreadsheets/d/<id>/…) or a sheet id",
    );
  }
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
}

/**
 * Downloads the configured Google Sheet into data/wallets.xlsx.
 * Returns { used: false } when no sheet is configured, so callers can fall back
 * to the local file; throws when a configured sheet cannot be fetched.
 */
export async function syncSheetFromUrl() {
  const url = sheetExportUrl();
  if (!url) return { used: false };

  const response = await fetch(url, { redirect: "follow", cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Google Sheet download failed (${response.status} ${response.statusText}) — is it shared with "anyone with the link"?`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  // An .xlsx is a zip archive; a login/permission page is HTML.
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('the sheet link did not return an .xlsx file — share it with "anyone with the link"');
  }

  await mkdir(dirname(cachedXlsxPath), { recursive: true });
  await writeFile(cachedXlsxPath, buffer);

  return { used: true, url, bytes: buffer.length, at: new Date().toISOString() };
}

/** Where the current run will get its wallets from, for the dashboard. */
export function sheetSource() {
  try {
    const url = sheetExportUrl();
    return url ? { kind: "google-sheet", url } : { kind: "file", url: null };
  } catch (error) {
    return { kind: "google-sheet", url: null, error: error.message };
  }
}
