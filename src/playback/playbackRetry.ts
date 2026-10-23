// What the host knows about retrying one track after the native engine refused
// to open its source, keyed by `QueueTrack.key`. Two facts, kept together
// because one event (`engine-error`) establishes both:
//
//  - the source it was given is not worth re-serving from any cache, and
//  - the next attempt should pick a *different* stream, not the same one.
//
// Both exist because signed CDN links (googlevideo above all) are refused at
// random: measured on real streams, the same request shape succeeded roughly
// three times in four and failed the rest, with no property of the request
// predicting which — and refusals cluster in time rather than attaching to a
// particular stream. Re-resolving mints a new link and gets a fresh draw, which
// is the whole of the recovery; the ladder is a last resort for the final
// attempt only, where the alternative is giving up rather than another try at
// full quality. See `streamLadderStep` for why it stays out of the way until
// then.
//
// This is a module-level store rather than a ref in either hook, and it is
// written directly rather than derived from the `engine-error` event, because
// `usePlayback` and `useStreamResolution` would otherwise both be listeners on
// that one event with an ordering dependency between them: `usePlayback` replays
// the track synchronously from its handler, so if it happened to be registered
// first the retry would resolve *before* the failure had been recorded, and
// quietly reuse the very source that just failed.

/** Track keys whose last resolved source failed to play. */
const stale = new Set<string>();
/** Track key → how many native attempts have already failed. */
const attempts = new Map<string, number>();
/** Track key → which resolver-chain entry its last resolve played from, and
 *  how long that chain was. */
const winners = new Map<string, { index: number; length: number }>();
/** Track key → how many chain entries its next resolve skips: the ones whose
 *  source already failed to play. */
const skips = new Map<string, number>();

/** Record a failed native attempt. Returns the new attempt count (1 = the first
 *  failure), which is also how far down the stream ladder the next pick goes. */
export function noteNativeFailure(key: string): number {
  stale.add(key);
  const next = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, next);
  return next;
}

/** True once per failure: the caller is now responsible for re-resolving.
 *  One-shot so a later, unrelated resolve isn't forced to re-answer a failure
 *  that has already been handled. */
export function consumeResolveStale(key: string): boolean {
  return stale.delete(key);
}

/** How many of the preferred video streams to step past for this track.
 *
 *  Deliberately one BEHIND the failure count, so the first retry re-picks the
 *  same rung and only the last native attempt descends. Refusals were measured
 *  as ~1 in 4 and showed no correlation with quality — a sweep of itags 137/136/
 *  135 minted from one extraction agreed on the outcome every time, and every
 *  rung fetched fine when probed directly. So a retry a rung lower has the same
 *  chance as a retry at the top, and merely costs resolution: retrying at the
 *  top three times ends at 1080p ~98% of the time, while descending each time
 *  lands a quarter of plays below it for no gain.
 *
 *  The step is kept for the LAST attempt only, where the alternative is not
 *  another try at 1080p but the track failing. A working 480p beats that. */
export function streamLadderStep(key: string): number {
  return Math.max(0, (attempts.get(key) ?? 0) - 1);
}

/** Record which chain entry a resolve played from (of how many). */
export function noteResolvedEntry(key: string, index: number, length: number): void {
  winners.set(key, { index, length });
}

/** How many chain entries the next resolve of this track skips. */
export function failedEntryCount(key: string): number {
  return skips.get(key) ?? 0;
}

/** The engine gave up on the source the last resolve found. If the chain has
 *  entries after it, the next resolve starts there — the playback fallback for
 *  a source that resolves fine but can't be played (a Subsonic id gone after a
 *  server rescan, a dead link) — and that source gets its own retries. False
 *  when there is nothing left to fall back to. */
export function fallBackFromFailedSource(key: string): boolean {
  const winner = winners.get(key);
  if (!winner || winner.index + 1 >= winner.length) return false;
  skips.set(key, winner.index + 1);
  winners.delete(key);
  attempts.delete(key);
  stale.add(key);
  return true;
}

/** Forget a track's retry state — it is starting over, not continuing. */
export function clearNativeRetries(key: string): void {
  stale.delete(key);
  attempts.delete(key);
  winners.delete(key);
  skips.delete(key);
}

/** Test seam. */
export function clearAllNativeRetries(): void {
  stale.clear();
  attempts.clear();
  winners.clear();
  skips.clear();
}
