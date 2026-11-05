import { request } from "../http.js";

/**
 * Quests the dashboard runs on its own, in this order.
 * Adding one is a single line — see GET /api/quests for the ids.
 */
export const AUTO_QUESTS = [
  { id: "daily_miner_signin", label: "daily check-in" },
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
 * Feature 4 — start a quest. The API arms it for `delaySeconds`, then claims it
 * by itself; there is no separate "complete" call.
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
