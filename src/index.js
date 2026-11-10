import { loadWallets, describeExpiry, describeProxy, describeMining } from "./wallets.js";
import { checkPositions, claimReady, startMine, runAllWallets } from "./app.js";
import { describeMine, DEFAULT_LOCATION } from "./mines.js";

const [, , command, ...rest] = process.argv;

function flags(args) {
  const out = {};
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    out[key] = value === undefined ? true : value;
  }
  return out;
}

const options = flags(rest);
const wallets = (await loadWallets()).filter(
  (wallet) => !options.wallet || wallet.label === options.wallet,
);

if (wallets.length === 0) {
  console.error(`No wallet matched --wallet=${options.wallet}`);
  process.exit(1);
}

// Left undefined unless the flag is given, so each wallet can use its sheet row.
const locationId = options.location;
const count = options.count ? Number(options.count) : undefined;

const usage = `Usage: node src/index.js <command> [flags]

Commands:
  positions            show every wallet's open sessions (read from wallets.xlsx)
  claim                claim every finished session
  start                start a new session per wallet
  run                  claim finished sessions, then start a new one (default)

Each wallet mines the Location from its row in wallets.xlsx (blank = greenstone-quarry).
The dashboard (npm run ui) runs the full cycle itself: balance, claim, then
floor(energy / mine cost) sessions, every 10 minutes.

Flags:
  --location=<id>      force a mining location (greenstone-quarry | crystal-cavern | ember-mine |
                       frozen-depths | void-rift)
  --count=<n>          force sessions per wallet (default 1; the dashboard computes it)
  --wallet=<label>     only this wallet
  --json               print raw JSON instead of the summary
`;

switch (command) {
  case "positions": {
    console.log("wallets:");
    for (const wallet of wallets) {
      console.log(
        `  ${wallet.label} ${wallet.walletAddress} — ${describeProxy(wallet)}, ${describeExpiry(wallet)}, ${describeMining(wallet)}`,
      );
    }

    for (const wallet of wallets) {
      try {
        const positions = await checkPositions(wallet);
        console.log(`\n[${wallet.label}] ${positions.length} open session(s)`);
        if (options.json) console.log(JSON.stringify(positions, null, 2));
        else {
          for (const p of positions) {
            const left = `${p.remainingSeconds}s`;
            console.log(`  ${p.locationId.padEnd(18)} ${left.padStart(6)} left  ${p.claimable ? "READY" : "     "}  ${p.id}`);
          }
        }
      } catch (error) {
        console.log(`\n[${wallet.label}] failed: ${error.message}`);
      }
    }
    break;
  }

  case "claim":
    for (const wallet of wallets) {
      const positions = await checkPositions(wallet);
      const claimed = await claimReady(wallet, positions);
      console.log(`\n[${wallet.label}] ${claimed.length} claim(s)`);
      if (options.json) console.log(JSON.stringify(claimed, null, 2));
      for (const c of claimed) {
        console.log(
          c.error
            ? `  failed: ${c.locationId} — ${c.error}`
            : `  +${c.gemsEarned} gems (${c.multiplier}x) from ${c.locationId}: ${c.rewards.join(", ")}`,
        );
      }
    }
    break;

  case "start":
    for (const wallet of wallets) {
      const started = await startMine(wallet, { locationId, count });
      const mine = describeMine(locationId || wallet.locationId || DEFAULT_LOCATION);
      console.log(`\n[${wallet.label}] ${mine}${count ? ` ×${count}` : ""}`);
      if (options.json) console.log(JSON.stringify(started, null, 2));
      for (const s of started) {
        console.log(
          s.error
            ? `  failed: ${s.error}`
            : s.skipped
              ? `  skipped: ${s.reason}`
              : `  started ${s.id} until ${s.endsAt} (energy left ${s.energy})`,
        );
      }
    }
    break;

  case "run":
  case undefined:
    await runAllWallets(wallets, { locationId, count });
    break;

  default:
    console.error(usage);
    process.exit(1);
}
