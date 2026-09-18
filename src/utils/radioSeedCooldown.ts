// Shown-seed cooldown for the Home radio carousel.
//
// `pick_radio_seeds` draws a weighted random sample, which alone still lets
// the same favorites recur across consecutive refreshes. The carousel therefore
// remembers the track ids it showed over its last few refreshes and passes them
// as `exclude`, so a refresh cannot hand back the cards the user just saw. The
// backend tops the row up from the excluded set when the library is too small
// to fill it without them (see `Database::pick_radio_seeds`), so the ring can
// be generous without ever thinning the carousel.
//
// Persisted under `radioSeedCooldown` as a plain `number[]`, oldest first.

/** How many refreshes' worth of seeds stay cooled down. */
export const RADIO_SEED_COOLDOWN_REFRESHES = 3;

/**
 * Append the seeds just shown to the ring and trim it to the last
 * `refreshes × perRefresh` entries, oldest first. A seed shown again (via the
 * small-library top-up) moves to the newest end rather than appearing twice,
 * so the ring never carries duplicates and never grows past its capacity.
 */
export function rememberShownSeeds(
  prev: readonly number[],
  shown: readonly number[],
  perRefresh: number,
  refreshes: number = RADIO_SEED_COOLDOWN_REFRESHES,
): number[] {
  const capacity = Math.max(0, Math.floor(perRefresh) * Math.floor(refreshes));
  if (capacity === 0) return [];
  const fresh = new Set(shown.filter((id) => Number.isFinite(id)));
  const kept = prev.filter((id) => Number.isFinite(id) && !fresh.has(id));
  const next = kept.concat(Array.from(fresh));
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

/** Read a persisted ring defensively — anything malformed reads as empty. */
export function coerceSeedCooldown(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}
