/**
 * Mining catalog, lowest rank first. Costs and durations are the "deep"
 * strategy values — the only strategy this app uses — and the game's own
 * `GET /api/mining/locations` response overrides them at runtime (see
 * features/mining-locations.js). `power` is the mining power the API wants
 * before it accepts a mine; molten-core's value is left at 0 because only the
 * live catalog reports it.
 */
export const MINES = [
  { id: "greenstone-quarry", name: "Greenstone Quarry", seconds: 1500, cost: 18, power: 0 },
  { id: "crystal-cavern", name: "Crystal Cavern", seconds: 4500, cost: 36, power: 25 },
  { id: "ember-mine", name: "Ember Mine", seconds: 13500, cost: 63, power: 60 },
  { id: "frozen-depths", name: "Frozen Depths", seconds: 36000, cost: 90, power: 120 },
  { id: "void-rift", name: "Void Rift", seconds: 72000, cost: 135, power: 250 },
  { id: "molten-core", name: "Molten Core", seconds: 108000, cost: 180, power: 0 },
];

/** Used when the sheet row leaves Location blank. */
export const DEFAULT_LOCATION = "greenstone-quarry";

/** Longest run, best multipliers — the only strategy this app starts. */
export const STRATEGY = "deep";

/** Every mine exposes this many veins per refresh. */
export const VEINS_PER_MINE = 6;

export const mineById = (id) => MINES.find((mine) => mine.id === id) ?? null;

export const describeMine = (id) => mineById(id)?.name ?? id;

export const costOf = (id) => mineById(id)?.cost ?? 63;

export const powerOf = (id) => mineById(id)?.power ?? 0;

/** Index in the low → high list; -1 when the id is unknown. */
export const rankOf = (id) => MINES.findIndex((mine) => mine.id === id);

const keyOf = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Turns whatever the sheet's Location cell says into a catalog id.
 * Accepts "ember-mine", "Ember Mine", "ember", or a mistyped "ember mine!".
 * Returns null when nothing matches.
 */
export function resolveLocation(value) {
  const wanted = keyOf(value);
  if (!wanted) return null;

  const match = (mine) =>
    keyOf(mine.id) === wanted ||
    keyOf(mine.name) === wanted ||
    keyOf(mine.id).startsWith(wanted) ||
    keyOf(mine.name).startsWith(wanted);

  return MINES.find(match)?.id ?? null;
}
