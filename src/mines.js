/**
 * Mining catalog. Durations and costs are from the game itself; `power` is the
 * mining power a wallet needs before the API accepts a session.
 */
export const MINES = [
  { id: "greenstone-quarry", name: "Greenstone Quarry", seconds: 600, cost: 10, power: 0 },
  { id: "crystal-cavern", name: "Crystal Cavern", seconds: 1800, cost: 20, power: 25 },
  { id: "ember-mine", name: "Ember Mine", seconds: 5400, cost: 35, power: 60 },
];

/** Used when the sheet row leaves Location blank. */
export const DEFAULT_LOCATION = "greenstone-quarry";

export const mineById = (id) => MINES.find((mine) => mine.id === id) ?? null;

export const describeMine = (id) => mineById(id)?.name ?? id;

export const costOf = (id) => mineById(id)?.cost ?? 35;

export const powerOf = (id) => mineById(id)?.power ?? 0;

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
