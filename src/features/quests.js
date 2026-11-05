import { request } from "../http.js";

/**
 * Quests the dashboard runs on its own, in this order.
 * Adding one is a single line — see GET /api/quests for the ids.
 */
export const AUTO_QUESTS = [
  { id: "daily_miner_signin", label: "daily check-in" },
  // Start + claim is enough: the claim accepts an empty tweetUrl, so the
  // X-engagement quest does not need a real tweet.
  { id: "tw_daily_engage", label: "social daily" },
  { id: "weekly_miner_checkin", label: "weekly check-in" },
];

/**
 * GET /api/quests → { daily: [], weekly: [], oneTime: [], resets: {...} }
 * Every quest carries: id, title, period, status ("available" | "started" |
 * "claimed"), delaySeconds, secondsLeft, rewardGems, rewardXp.
 */
export async function listQuests(wallet, { verbose = true } = {}) {
  const { body } = await request({ method: "GET", path: "/api/quests", wallet, verbose });
  return body ?? {};
}

/**
 * Feature 4 — start a quest. The API arms it for `delaySeconds`; afterwards the
 * reward has to be collected with POST /api/quests/claim.
 *
 *   POST /api/quests/start   { "questId": "daily_miner_signin" }
 */
export async function startQuest(wallet, questId, { verbose = true } = {}) {
  if (!questId) throw new Error("startQuest needs a quest id");
  const { body } = await request({
    method: "POST",
    path: "/api/quests/start",
    payload: { questId },
    wallet,
    verbose,
  });
  return body ?? {};
}

/**
 * Feature 4b — collect a started quest once its delay has passed.
 *
 *   POST /api/quests/claim   { "questId": "daily_miner_signin", "tweetUrl": "" }
 *   → { success, message, reward: { gems, xp }, user: { gems, energy, ... } }
 *
 * `tweetUrl` is required by the body shape but empty for every non-social quest.
 */
export async function claimQuest(wallet, questId, { tweetUrl = "", verbose = true } = {}) {
  if (!questId) throw new Error("claimQuest needs a quest id");
  const { body } = await request({
    method: "POST",
    path: "/api/quests/claim",
    payload: { questId, tweetUrl },
    wallet,
    verbose,
  });
  return body ?? {};
}

export function allQuests(body) {
  return ["daily", "weekly", "oneTime"].flatMap((key) =>
    Array.isArray(body?.[key]) ? body[key] : [],
  );
}

export function findQuest(body, questId) {
  return allQuests(body).find((quest) => quest.id === questId) ?? null;
}

/** Seconds until the period resets (`dailySecondsLeft` / `weeklySecondsLeft`). */
export function secondsUntilReset(body, period = "daily") {
  const seconds = body?.resets?.[`${period}SecondsLeft`];
  return typeof seconds === "number" ? seconds : null;
}
