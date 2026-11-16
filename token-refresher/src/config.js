import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Tiny .env loader so this app needs no dotenv dependency. Same shape as the
// miner's src/config.js: real environment variables win over the file.
const envPath = fileURLToPath(new URL("../.env", import.meta.url));

try {
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
} catch {
  // No .env file: rely on the real environment.
}

export const config = {
  baseUrl: (process.env.GEM_BASE_URL || "https://gemapi.bullshot.io").replace(/\/+$/, ""),
  keysXlsx: process.env.KEYS_XLSX || "./wallets-keys.xlsx",
  sheetId: process.env.SHEET_ID || "",
  derivationLimit: Number(process.env.DERIVATION_LIMIT || 20),
  concurrency: Math.max(1, Number(process.env.CONCURRENCY || 3)),
  authRetries: Math.max(0, Number(process.env.AUTH_RETRIES || 3)),
};
