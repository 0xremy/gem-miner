import { describeExpiry, describeProxy } from "./wallets.js";
import { miningPositions } from "./features/mining-positions.js";
import { listMiningPositions } from "./features/mining-positions-list.js";
import { claimPosition, isClaimable } from "./features/mining-claim.js";
import { costOf, DEFAULT_LOCATION } from "./mines.js";

const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const reasonOf = (error) => {
  const body = error.body;
  if (!body) return error.message;
  const detail = typeof body === "string" ? body : body.message || body.error || JSON.stringify(body);
  return `${error.message} — ${detail}`;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function checkPositions(wallet) {
  const { body } = await listMiningPositions(wallet, { verbose: false });
  if (!Array.isArray(body)) throw new Error("Unexpected positions payload: expected an array");
  return body.map((p) => ({ ...p, claimable: isClaimable(p) }));
}

export async function claimReady(wallet, positions) {
  const ready = positions.filter((p) => p.claimable);
  const claimed = [];
  for (const position of ready) {
    try {
      const { body } = await claimPosition(wallet, position.id, { verbose: false });
      claimed.push({
        locationId: position.locationId,
        gemsEarned: body.gemsEarned,
        multiplier: body.multiplier,
        rewards: body.rewards ?? [],
        energy: body.user?.energy,
      });
    } catch (error) {
      claimed.push({ locationId: position.locationId, error: reasonOf(error) });
    }
  }
  return claimed;
}

/**
 * Explicit argument > the wallet's sheet row > the built-in default, so a
 * `Location`/`Count` cell in wallets.xlsx drives that wallet on its own.
 */
export async function startMine(wallet, { locationId, count } = {}) {
  const location = locationId || wallet.locationId || DEFAULT_LOCATION;
  const sessions = Math.max(1, Math.min(20, Number(count) || 1));
  const cost = costOf(location);
  const started = [];

  for (let i = 0; i < sessions; i += 1) {
    try {
      const { body } = await miningPositions(wallet, { locationId: location, verbose: false });
      const energy = body.user?.energy;
      started.push({
        locationId: location,
        id: body.position?.id,
        endsAt: body.position?.endsAt,
        energy,
      });
      if (typeof energy === "number" && energy < cost && i + 1 < sessions) {
        started.push({ skipped: true, reason: `energy ${energy} below cost ${cost}` });
        break;
      }
      if (typeof energy === "number" && energy < cost) break;
    } catch (error) {
      started.push({ locationId: location, error: reasonOf(error) });
      break;
    }
  }

  return started;
}

/** Check → claim everything finished → start a new session if allowed. */
export async function runWallet(wallet, options = {}) {
  const { locationId, count, start = true } = options;
  const header = `[${wallet.label}] ${short(wallet.walletAddress)}  ${describeProxy(wallet)}, ${describeExpiry(wallet)}`;
  console.log(`\n${header}`);

  if (wallet.expired) {
    console.log("  skipped: token expired, log in again and update wallets.json");
    return { wallet, skipped: true };
  }

  let positions;
  try {
    positions = await checkPositions(wallet);
  } catch (error) {
    console.log(`  positions failed: ${error.message}`);
    return { wallet, error: error.message };
  }

  const ready = positions.filter((p) => p.claimable);
  console.log(`  positions: ${positions.length} open, ${ready.length} ready to claim`);
  for (const p of ready) console.log(`    ready: ${p.locationId} ${p.id}`);

  const claimed = await claimReady(wallet, positions);
  for (const c of claimed) {
    if (c.error) console.log(`    claim failed: ${c.locationId} — ${c.error}`);
    else console.log(`    claimed: ${c.locationId} +${c.gemsEarned} gems (${c.multiplier}x)`);
  }

  const started = start ? await startMine(wallet, { locationId, count }) : [];
  for (const s of started) {
    if (s.error) console.log(`    start failed: ${s.locationId} — ${s.error}`);
    else if (s.skipped) console.log(`    start skipped: ${s.reason}`);
    else console.log(`    started: ${s.locationId} ${s.id} until ${s.endsAt} (energy left ${s.energy})`);
  }

  const gems = claimed.reduce((sum, c) => sum + (c.gemsEarned ?? 0), 0);
  return { wallet, positions: positions.length, ready: ready.length, claimed, started, gems };
}

export async function runAllWallets(wallets, options = {}) {
  const results = [];
  for (const wallet of wallets) {
    results.push(await runWallet(wallet, options));
    await sleep(400);
  }

  console.log("\n── SUMMARY ─────────────────────────────────────────");
  console.log(
    ["wallet", "address", "open", "claimed", "gems"].map((h) => h.padEnd(12)).join(""),
  );
  for (const r of results) {
    if (r.skipped || r.error) {
      console.log(`${r.wallet.label.padEnd(12)}${short(r.wallet.walletAddress).padEnd(12)}${r.skipped ? "skipped" : "error"}`);
      continue;
    }
    console.log(
      `${r.wallet.label.padEnd(12)}${short(r.wallet.walletAddress).padEnd(12)}` +
        `${String(r.positions).padEnd(12)}${String(r.claimed.filter((c) => !c.error).length).padEnd(12)}${r.gems}`,
    );
  }

  return results;
}
