import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWallets, describeProxy } from "./wallets.js";
import { syncSheetFromUrl } from "./sheet-source.js";
import { checkPositions, claimReady, startMine } from "./app.js";
import { userBalance } from "./features/balance.js";
import {
  AUTO_QUESTS,
  claimQuest,
  findQuest,
  listQuests,
  secondsUntilReset,
  startQuest,
} from "./features/quests.js";
import { DEFAULT_LOCATION, costOf, powerOf, describeMine } from "./mines.js";

/** Default gap between cycles; the dashboard can change it at runtime. */
export const DEFAULT_INTERVAL_MINUTES = 10;
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 1440;

/** Safety cap so one huge energy balance cannot fire hundreds of requests. */
export const MAX_SESSIONS = 20;

/** Gap between wallets, so six wallets do not burst the API at once. */
const WALLET_GAP_MS = 400;

const settingsPath = fileURLToPath(new URL("../data/settings.json", import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const reasonOf = (error) => {
  const body = error?.body;
  const detail = typeof body === "string" ? body : body?.error || body?.message;
  return detail ? `${error.message} — ${detail}` : error.message;
};

function readIntervalMinutes() {
  try {
    const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
    const minutes = Number(saved.intervalMinutes);
    if (Number.isFinite(minutes) && minutes >= MIN_INTERVAL_MINUTES && minutes <= MAX_INTERVAL_MINUTES) {
      return Math.round(minutes);
    }
  } catch {
    // no settings yet — use the default
  }
  return DEFAULT_INTERVAL_MINUTES;
}

function saveIntervalMinutes(minutes) {
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify({ intervalMinutes: minutes }, null, 2)}\n`);
  } catch (error) {
    log(`could not save settings: ${error.message}`, "bad");
  }
}

export const state = {
  running: false,
  walletCount: 0,
  lastRunAt: null,
  lastRunReason: null,
  lastDurationMs: null,
  nextRunAt: null,
  /** Auto-run is off until someone turns it on: nothing runs on boot. */
  loop: { enabled: false, intervalMinutes: readIntervalMinutes() },
  wallets: [],
  totals: { claimed: 0, gems: 0, started: 0, quests: 0, questGems: 0 },
  /** How many wallets this run has finished / will check, for the progress chip. */
  progress: { done: 0, total: null },
  /** "mining" | "quests" while a run is in flight — only one may run at a time. */
  runKind: null,
  runLabel: null,
  /** Set by the Stop buttons: the run stops after the wallet in progress. */
  stopRequested: false,
  log: [],
};

const emptyTotals = () => ({ claimed: 0, gems: 0, started: 0, quests: 0, questGems: 0 });

/** One finished wallet → one more table row; the dashboard polls for it. */
function publish(row) {
  state.wallets.push(row);
  state.progress.done += 1;
  state.totals.claimed += row.claimed;
  state.totals.gems += row.claimedGems;
  state.totals.started += row.started;
  state.totals.quests += row.questsClaimed;
  state.totals.questGems += row.questGems;
}

/** Empty the table before the first wallet, so it fills up one row at a time. */
function beginRun(reason, kind = "mining", label = null) {
  clearTimer();
  state.nextRunAt = null;
  state.running = true;
  state.runKind = kind;
  state.runLabel = label;
  state.stopRequested = false;
  state.lastRunReason = reason;
  state.wallets = [];
  state.totals = emptyTotals();
  state.progress = { done: 0, total: null };
}

/** "a mining run is already in progress" — the same wording the API and the UI use. */
function busyMessage() {
  return state.runKind === "quests"
    ? `${state.runLabel ?? "a side-quest"} run is already in progress — press Stop first`
    : "a mining run is already in progress — press Stop first";
}

/**
 * Stop buttons (mining and side quests): the wallet in progress is finished, so
 * nothing is left half-claimed, then the run ends and the auto loop stays off.
 */
export function requestStop() {
  if (!state.running) return { stopped: false, error: "nothing is running" };
  if (state.stopRequested) return { stopped: true, alreadyStopping: true };

  state.stopRequested = true;
  if (state.loop.enabled) {
    state.loop.enabled = false;
    clearTimer();
    state.nextRunAt = null;
  }
  log(`stop requested — finishing the wallet in progress, then stopping`, "bad");
  return { stopped: true };
}

/**
 * Re-imports the wallet sheet at the start of every run: the Google Sheet is
 * downloaded over the cached data/wallets.xlsx when one is configured, then the
 * file on disk is parsed from scratch (no memory cache).
 */
async function refreshWallets() {
  try {
    const sheet = await syncSheetFromUrl();
    if (sheet.used) {
      log(`sheet re-imported from Google Sheets (${(sheet.bytes / 1024).toFixed(1)} KB)`);
    }
  } catch (error) {
    log(`could not refresh the sheet: ${error.message} — using the last copy`, "bad");
  }

  const wallets = await loadWallets({ quiet: true, fresh: true });
  state.walletCount = wallets.length;
  state.progress.total = wallets.length;
  log(`${wallets.length} wallet(s) loaded`);
  return wallets;
}

function log(text, kind = "") {
  state.log.unshift({ at: new Date().toISOString(), kind, text });
  if (state.log.length > 200) state.log.length = 200;
}

function newRow(wallet) {
  const mine = wallet.locationId || DEFAULT_LOCATION;
  const configured = mine === wallet.locationId;
  return {
    label: wallet.label,
    address: short(wallet.walletAddress),
    proxy: describeProxy(wallet),
    mine,
    mineName: describeMine(mine),
    mineSource: configured ? "sheet" : "default",
    cost: costOf(mine),
    powerRequired: powerOf(mine),
    energy: null,
    energyCapacity: null,
    miningPower: null,
    gemsBalance: null,
    open: 0,
    ready: 0,
    claimed: 0,
    claimedGems: 0,
    started: 0,
    quests: [],
    questsClaimed: 0,
    questGems: 0,
    status: "running",
    note: null,
    error: null,
    durationMs: null,
  };
}

/**
 * Daily/weekly/social quests, driven by GET /api/quests.
 * A quest that is `available` is started, then claimed with
 * POST /api/quests/claim once its `delaySeconds` has passed. Nothing is waited
 * on unless a quest was actually started, so an ordinary cycle pays one cheap
 * request per wallet.
 */
async function runQuests(wallet, row, questList = AUTO_QUESTS) {
  let quests;
  try {
    quests = await listQuests(wallet, { verbose: false });
  } catch (error) {
    log(`[${row.label}] quests unavailable: ${reasonOf(error)}`, "bad");
    return;
  }

  const pending = [];

  for (const { id, label, enabled } of questList) {
    if (enabled && !enabled(wallet)) {
      row.quests.push({ id, label, status: "skipped", note: "not in the sheet", gems: 0 });
      log(`[${row.label}] quest ${label}: skipped (turned off in the sheet)`);
      continue;
    }

    const quest = findQuest(quests, id);
    if (!quest) {
      log(`[${row.label}] quest ${label}: not offered on this account`);
      continue;
    }

    if (quest.status === "claimed") {
      const left = secondsUntilReset(quests, quest.period ?? "daily");
      row.quests.push({ id, label, status: "claimed", note: "already claimed", gems: 0 });
      log(
        `[${row.label}] quest ${label}: already claimed` +
          (left ? ` — resets in ${(left / 3600).toFixed(1)}h` : ""),
      );
      continue;
    }

    if (quest.status === "started") {
      const seconds = Number(quest.secondsLeft ?? quest.delaySeconds ?? 0);
      pending.push({ id, label, delaySeconds: seconds });
      row.quests.push({ id, label, status: "started", note: `${seconds}s left`, gems: 0 });
      log(`[${row.label}] quest ${label}: already in progress (${seconds}s left)`);
      continue;
    }

    try {
      const started = await startQuest(wallet, id, { verbose: false });
      const seconds = Number(started.delaySeconds ?? quest.delaySeconds ?? 0);
      pending.push({ id, label, delaySeconds: seconds });
      row.quests.push({
        id,
        label,
        status: started.status ?? "started",
        note: `${seconds}s delay`,
        gems: 0,
      });
      log(`[${row.label}] quest ${label}: started (${seconds}s delay)`, "ok");
    } catch (error) {
      row.quests.push({ id, label, status: "error", note: reasonOf(error), gems: 0 });
      log(`[${row.label}] quest ${label} failed: ${reasonOf(error)}`, "bad");
    }
  }

  if (pending.length === 0) return;

  const waitMs = Math.max(...pending.map((item) => item.delaySeconds * 1000)) + 1500;
  await sleep(waitMs);

  for (const item of pending) {
    const entry = row.quests.find((q) => q.id === item.id);

    try {
      const claimed = await claimQuest(wallet, item.id, { verbose: false });
      const gems = Number(claimed.reward?.gems ?? 0);
      row.questsClaimed += 1;
      row.questGems += gems;
      if (typeof claimed.user?.gems === "number") row.gemsBalance = claimed.user.gems;
      if (entry) {
        entry.status = "claimed";
        entry.gems = gems;
        entry.note = "claimed";
      }
      log(
        `[${row.label}] quest ${item.label}: ${claimed.message ?? `claimed +${gems} gems`}`,
        "ok",
      );
      continue;
    } catch (error) {
      if (entry) {
        entry.status = "error";
        entry.note = reasonOf(error);
      }
      log(`[${row.label}] quest ${item.label} claim failed: ${reasonOf(error)}`, "bad");
    }

    // The claim was refused (still cooling down, or already collected) — read the
    // quest list once so the row shows what actually happened.
    let after;
    try {
      after = await listQuests(wallet, { verbose: false });
    } catch {
      continue;
    }

    const quest = findQuest(after, item.id);
    if (quest?.status !== "claimed") continue;

    const gems = Number(quest.rewardGems ?? 0);
    row.questsClaimed += 1;
    row.questGems += gems;
    if (entry) {
      entry.status = "claimed";
      entry.gems = gems;
      entry.note = "claimed";
    }
    log(`[${row.label}] quest ${item.label}: already claimed +${gems} gems`, "ok");
  }
}

/**
 * One wallet, in the order asked for:
 *   1. balance  → energy left
 *   2. positions → claim whatever is claimable
 *   3. floor(energy / mine cost) sessions, gated by mining power
 */
async function runOne(wallet) {
  const row = newRow(wallet);
  const startedAt = Date.now();

  try {
    if (wallet.expired) throw new Error("token expired — update the Token cell");

    // 1. Balance
    const balance = (await userBalance(wallet, { verbose: false })).body ?? {};
    row.energy = typeof balance.energy === "number" ? balance.energy : null;
    row.energyCapacity = balance.energyCapacity ?? null;
    row.miningPower = balance.miningPower ?? null;
    row.gemsBalance = balance.gems ?? null;
    log(
      `[${row.label}] balance: ${row.energy ?? "?"} energy${row.energyCapacity ? `/${row.energyCapacity}` : ""}, ` +
        `${row.miningPower ?? "?"} power, ${row.gemsBalance ?? "?"} gems`,
    );

    // 2. Positions → claim
    const positions = await checkPositions(wallet);
    row.open = positions.length;
    const ready = positions.filter((position) => position.claimable);
    row.ready = ready.length;
    log(`[${row.label}] positions: ${row.open} open, ${row.ready} claimable`);

    if (ready.length > 0) {
      const claimed = await claimReady(wallet, positions);
      for (const claim of claimed) {
        if (claim.error) {
          row.note = `claim failed: ${claim.error}`;
          log(`[${row.label}] claim failed on ${claim.locationId}: ${claim.error}`, "bad");
          continue;
        }
        row.claimed += 1;
        row.claimedGems += Number(claim.gemsEarned ?? 0);
        // Claim responses carry the freshest energy figure.
        if (typeof claim.energy === "number") row.energy = claim.energy;
        log(
          `[${row.label}] claimed ${claim.locationId} +${claim.gemsEarned} gems (${claim.multiplier}x)`,
          "ok",
        );
      }
    }

    // 3. How many sessions this energy pays for
    const energy = typeof row.energy === "number" ? row.energy : 0;
    const affordable = Math.floor(energy / row.cost);
    // Sessions come purely from energy; MAX_SESSIONS is only a burst guard.
    let sessions = Math.max(0, Math.min(affordable, MAX_SESSIONS));

    if (row.miningPower !== null && row.miningPower < row.powerRequired) {
      sessions = 0;
      row.note = `needs ${row.powerRequired} mining power, has ${row.miningPower}`;
    }

    log(
      `[${row.label}] ${energy} energy ÷ ${row.cost} (${row.mineName}) = ${affordable} session(s)` +
        (sessions !== affordable ? ` → starting ${sessions}` : ""),
    );

    if (sessions > 0) {
      const started = await startMine(wallet, { locationId: row.mine, count: sessions });
      for (const attempt of started) {
        if (attempt.error) {
          row.error = attempt.error;
          log(`[${row.label}] start failed: ${attempt.error}`, "bad");
          continue;
        }
        if (attempt.skipped) {
          log(`[${row.label}] start stopped: ${attempt.reason}`);
          continue;
        }
        row.started += 1;
        if (typeof attempt.energy === "number") row.energy = attempt.energy;
        log(`[${row.label}] started ${row.mineName} (energy left ${attempt.energy ?? "?"})`, "ok");
      }
    }

    // 4. Quests (daily check-in, ...) — last, so a quest hiccup never blocks mining.
    await runQuests(wallet, row);

    row.status = row.error ? "error" : "ok";
  } catch (error) {
    row.status = "error";
    row.error = error.message;
    log(`[${row.label}] failed: ${error.message}`, "bad");
  }

  row.durationMs = Date.now() - startedAt;
  log(
    `[${row.label}] done: ${row.claimed} claimed (+${row.claimedGems.toFixed(2)} gems), ` +
      `${row.started} started, energy ${row.energy ?? "?"}`,
  );
  return row;
}

/**
 * Processes every wallet in the sheet, one after another.
 * Never starts a second cycle while one is in flight: the next one is only
 * booked from the finally block below, i.e. after every wallet has been checked.
 */
export async function runCycle({ reason = "manual" } = {}) {
  if (state.running) {
    log(`cycle skipped (${reason}): ${busyMessage()}`);
    // A loop slot that lands on another run is retried instead of dropped, so
    // the loop survives a side-quest run overlapping its timer.
    if (state.loop.enabled) scheduleNext(30_000);
    return state;
  }

  beginRun(reason, "mining");
  const startedAt = Date.now();
  log(`cycle started (${reason})`, "ok");

  try {
    let wallets = [];
    try {
      wallets = await refreshWallets();
    } catch (error) {
      log(`could not read wallets: ${error.message}`, "bad");
      return state;
    }

    // One wallet at a time, each row published as soon as it is done.
    for (const wallet of wallets) {
      if (state.stopRequested) break;
      publish(await runOne(wallet));
      await sleep(WALLET_GAP_MS);
    }

    state.lastRunAt = new Date().toISOString();
    state.lastDurationMs = Date.now() - startedAt;
    if (state.stopRequested) {
      state.lastRunReason = `${reason} · stopped`;
      log(
        `cycle stopped after ${state.wallets.length}/${wallets.length} wallet(s): ` +
          `${state.totals.claimed} claimed, +${state.totals.gems.toFixed(2)} gems`,
        "bad",
      );
      return state;
    }

    log(
      `cycle finished in ${(state.lastDurationMs / 1000).toFixed(1)}s: ` +
        `${state.totals.claimed} claimed, ${state.totals.gems.toFixed(2)} gems, ${state.totals.started} started, ` +
        `${state.totals.quests} quest(s) +${state.totals.questGems} gems`,
      "ok",
    );
    return state;
  } finally {
    state.running = false;
    state.runKind = null;
    state.runLabel = null;
    state.stopRequested = false;
    // Only after the last wallet: a cycle that ran longer than the interval
    // queues the next one with no extra wait, never overlapping this one.
    if (state.loop.enabled) {
      const elapsed = Date.now() - startedAt;
      scheduleNext(state.loop.intervalMinutes * 60_000 - elapsed);
    }
  }
}

/**
 * One quest feature (daily check-in, social daily, weekly check-in) for every
 * wallet — what the three dashboard buttons trigger. No mining, and it shares
 * `state.running` with runCycle so a clicked quest never overlaps a cycle.
 */
export async function runQuestFeature(questId, { reason = "quest" } = {}) {
  const feature = AUTO_QUESTS.find((quest) => quest.id === questId);
  if (!feature) {
    throw Object.assign(new Error(`unknown quest "${questId}"`), { status: 400 });
  }
  if (state.running) return { started: false, error: busyMessage() };

  beginRun(reason, "quests", feature.label);
  const startedAt = Date.now();
  log(`quest run started (${feature.label})`, "ok");

  try {
    let wallets = [];
    try {
      wallets = await refreshWallets();
    } catch (error) {
      log(`could not read wallets: ${error.message}`, "bad");
      return { started: true };
    }

    // Same clearing rule as a cycle: the table refills one wallet at a time.
    for (const wallet of wallets) {
      if (state.stopRequested) break;
      const row = newRow(wallet);
      const walletStartedAt = Date.now();

      try {
        if (wallet.expired) throw new Error("token expired — update the Token cell");
        await runQuests(wallet, row, [feature]);
        row.status = row.error ? "error" : "ok";
      } catch (error) {
        row.status = "error";
        row.error = error.message;
        log(`[${row.label}] ${feature.label} failed: ${error.message}`, "bad");
      }

      row.durationMs = Date.now() - walletStartedAt;
      publish(row);
      await sleep(WALLET_GAP_MS);
    }

    state.lastRunAt = new Date().toISOString();
    state.lastDurationMs = Date.now() - startedAt;

    const claimed = state.totals.quests;
    const gems = state.totals.questGems;
    if (state.stopRequested) {
      state.lastRunReason = `${reason} · stopped`;
      log(
        `${feature.label} stopped after ${state.wallets.length}/${wallets.length} wallet(s): ` +
          `${claimed} claimed, +${gems} gems`,
        "bad",
      );
      return { started: true, stopped: true, claimed, gems };
    }

    log(
      `quest run finished in ${(state.lastDurationMs / 1000).toFixed(1)}s: ` +
        `${feature.label} claimed on ${claimed}/${state.wallets.length} wallet(s), +${gems} gems`,
      "ok",
    );
    return { started: true, claimed, gems };
  } finally {
    state.running = false;
    state.runKind = null;
    state.runLabel = null;
    state.stopRequested = false;
    // Same rule as a cycle: the loop counts from the end of this run.
    if (state.loop.enabled) {
      scheduleNext(state.loop.intervalMinutes * 60_000 - (Date.now() - startedAt));
    }
  }
}

let timer = null;

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function scheduleNext(delayMs) {
  clearTimer();
  if (!state.loop.enabled) {
    state.nextRunAt = null;
    return;
  }

  const delay = Math.max(0, delayMs);
  state.nextRunAt = new Date(Date.now() + delay).toISOString();
  if (delay === 0) {
    log(`previous cycle ran past the ${state.loop.intervalMinutes} min interval — next one starts now`);
  }

  timer = setTimeout(() => {
    timer = null;
    // runCycle re-books the next slot once every wallet has been checked.
    runCycle({ reason: "loop" });
  }, delay);
}

/**
 * Turns the automatic loop on/off and/or changes the interval.
 * The interval is written to data/settings.json so a restart keeps it, but the
 * loop itself always comes back off: nothing runs until "Run 1 loop"/"Start loop".
 */
export function setLoop({ enabled, intervalMinutes } = {}) {
  if (intervalMinutes !== undefined) {
    const minutes = Number(intervalMinutes);
    if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
      throw new Error(`interval must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES} minutes`);
    }
    state.loop.intervalMinutes = Math.round(minutes);
    saveIntervalMinutes(state.loop.intervalMinutes);
  }

  if (enabled !== undefined) {
    state.loop.enabled = Boolean(enabled);
    if (!state.loop.enabled) {
      clearTimer();
      state.nextRunAt = null;
      log("auto-run stopped", "");
    } else {
      log(`auto-run on: every ${state.loop.intervalMinutes} min`, "ok");
      if (!state.running) scheduleNext(state.loop.intervalMinutes * 60_000);
    }
  } else if (state.loop.enabled && !state.running) {
    // Interval edited while the loop was idle → restart the countdown from now.
    scheduleNext(state.loop.intervalMinutes * 60_000);
  }

  return loopState();
}

export function loopState() {
  return {
    enabled: state.loop.enabled,
    intervalMinutes: state.loop.intervalMinutes,
    nextRunAt: state.nextRunAt,
  };
}

/** Manual "Run 1 loop"; returns false when any run is already in flight. */
export function triggerNow(reason = "manual") {
  if (state.running) return false;
  runCycle({ reason });
  return true;
}

/** Plain snapshot for the report endpoint. */
export function snapshot() {
  return {
    running: state.running,
    walletCount: state.walletCount,
    lastRunAt: state.lastRunAt,
    lastRunReason: state.lastRunReason,
    lastDurationMs: state.lastDurationMs,
    nextRunAt: state.nextRunAt,
    progress: state.progress,
    runKind: state.runKind,
    runLabel: state.runLabel,
    stopRequested: state.stopRequested,
    loop: { enabled: state.loop.enabled, intervalMinutes: state.loop.intervalMinutes },
    questButtons: AUTO_QUESTS.map(({ id, label }) => ({ id, label })),
    wallets: state.wallets,
    totals: state.totals,
    log: state.log.slice(0, 120),
  };
}
