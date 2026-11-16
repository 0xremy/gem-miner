/**
 * Daily and weekly check-in for one wallet.
 *
 * The API arms a quest with POST /api/quests/start and only then it can be
 * collected with POST /api/quests/claim, after the quest's own `delaySeconds`.
 * A quest that is already `started` is picked up where it left off, one that is
 * `claimed` is left alone until its period resets.
 */

export const CHECKIN_QUESTS = [
  { id: "daily_miner_signin", label: "Daily check-in", period: "daily" },
  { id: "weekly_miner_checkin", label: "Weekly check-in", period: "weekly" },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function allQuests(body) {
  return ["daily", "weekly", "oneTime"].flatMap((key) =>
    Array.isArray(body?.[key]) ? body[key] : [],
  );
}

function findQuest(body, questId) {
  return allQuests(body).find((quest) => quest.id === questId) ?? null;
}

function secondsUntilReset(body, period) {
  const seconds = body?.resets?.[`${period}SecondsLeft`];
  return typeof seconds === "number" ? seconds : null;
}

const hours = (seconds) => `${(seconds / 3600).toFixed(1)}h`;

/**
 * Runs both check-ins for a wallet and returns one record per quest, plus the
 * gems earned. `dryRun` reads the quest list and reports what it would claim,
 * arming nothing.
 */
export async function runCheckins({ name, address, client, dryRun = false }) {
  const quests = await client.quests();
  const results = [];
  const pending = [];

  for (const quest of CHECKIN_QUESTS) {
    const entry = { id: quest.id, label: quest.label, status: "skipped", gems: 0, note: "" };
    results.push(entry);

    const live = findQuest(quests, quest.id);
    if (!live) {
      entry.note = "not offered on this account";
      continue;
    }

    if (live.status === "claimed") {
      const left = secondsUntilReset(quests, quest.period);
      entry.status = "claimed";
      entry.note = left ? `already claimed — resets in ${hours(left)}` : "already claimed";
      continue;
    }

    if (live.status === "started") {
      const seconds = Number(live.secondsLeft ?? live.delaySeconds ?? 0);
      pending.push({ entry, seconds });
      continue;
    }

    if (dryRun) {
      entry.status = "available";
      entry.note = `would start + claim (+${Number(live.rewardGems ?? 0)} gems)`;
      continue;
    }

    try {
      const started = await client.startQuest(quest.id);
      const seconds = Number(started?.delaySeconds ?? live.delaySeconds ?? 0);
      pending.push({ entry, seconds });
    } catch (error) {
      entry.status = "error";
      entry.note = error.message;
    }
  }

  if (pending.length === 0) {
    return { name, address, results, claimed: 0, gems: 0, gemsBalance: null, dryRun };
  }

  // One wait for both quests: the longer delay covers the shorter one.
  const waitMs = Math.max(...pending.map((item) => item.seconds * 1000)) + 1500;
  await sleep(waitMs);

  let gems = 0;
  let claimed = 0;
  let gemsBalance = null;

  for (const { entry } of pending) {
    try {
      const body = await client.claimQuest(entry.id);
      const reward = Number(body?.reward?.gems ?? 0);
      gems += reward;
      claimed += 1;
      entry.status = "claimed";
      entry.gems = reward;
      entry.note = body?.message ?? `claimed +${reward} gems`;
      if (typeof body?.user?.gems === "number") gemsBalance = body.user.gems;
    } catch (error) {
      // The claim can be refused for a cooling-down quest — ask what the server
      // thinks the status is instead of guessing.
      try {
        const after = await client.quests();
        const live = findQuest(after, entry.id);
        if (live?.status === "claimed") {
          const reward = Number(live.rewardGems ?? 0);
          gems += reward;
          claimed += 1;
          entry.status = "claimed";
          entry.gems = reward;
          entry.note = "claimed";
          continue;
        }
        entry.status = live?.status ?? "error";
        entry.note = `${error.message}${live ? ` — now ${live.status}` : ""}`;
      } catch {
        entry.status = "error";
        entry.note = error.message;
      }
    }
  }

  return { name, address, results, claimed, gems, gemsBalance, dryRun };
}
