import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Tiny .env loader so the project stays dependency-free.
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
  // No .env file: fall back to real environment variables.
}

export const config = {
  baseUrl: (process.env.GEM_BASE_URL || "https://gemapi.bullshot.io").replace(/\/+$/, ""),
  token: process.env.GEM_API_TOKEN || "",
  walletAddress: process.env.GEM_WALLET_ADDRESS || "",
};

export function requireAuth() {
  if (!config.token) {
    throw new Error("GEM_API_TOKEN is missing. Add it to .env (see .env.example).");
  }
  return config;
}
