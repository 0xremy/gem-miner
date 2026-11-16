import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Tiny .env loader (no dotenv dependency); real environment variables win.
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
  sheetId: process.env.SHEET_ID || "",
  /** Mining Power I: flat +5 for 250 gems. */
  upgradeId: process.env.UPGRADE_ID || "upg-power-1",
  upgradeCost: Number(process.env.UPGRADE_COST || 250),
  upgradeIncrement: Number(process.env.UPGRADE_INCREMENT || 5),
  /** Stop once miningPower reaches this. 2 + 12×5 = 62 is the first stop past 60. */
  targetPower: Number(process.env.TARGET_POWER || 62),
  /** Energy Capacity I: +20 capacity for 180 gems, repeated until the gems run out. */
  energyUpgradeId: process.env.ENERGY_UPGRADE_ID || "upg-energy-1",
  energyIncrement: Number(process.env.ENERGY_INCREMENT || 20),
  concurrency: Math.max(1, Number(process.env.CONCURRENCY || 3)),
  retries: Math.max(0, Number(process.env.AUTH_RETRIES || 3)),
};
