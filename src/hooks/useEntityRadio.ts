import { useCallback } from "react";
import { useDetailActions } from "../contexts/DetailViewContext";
import { useTrackLikeStore } from "../contexts/TrackLikeContext";
import { pickRadioSeed, seedOwnLike, type SeedCandidate, type SeedLikeOf } from "../utils/radioSeed";

/**
 * The hero Radio button of an artist / album / tag page: picks a weighted
 * random seed from the page's tracks (utils/radioSeed) and starts a station
 * through the canonical radio actions — `startRadio` for a library row,
 * `startRadioByName` for a provider-only one. Returns undefined when there is
 * nothing to seed from, which the hero shows as a disabled button.
 *
 * Like states come from the track-like store, so a provider-only row the user
 * liked or disliked weighs (or is excluded) like a library one.
 */
export function useEntityRadio(candidates: SeedCandidate[]): (() => void) | undefined {
  const { startRadio, startRadioByName } = useDetailActions();
  const store = useTrackLikeStore();
  const likedOf: SeedLikeOf = useCallback(
    (seed) => (store ? store.lookup(seed.track.title, seed.track.artist_name, seedOwnLike(seed)) : seedOwnLike(seed)),
    [store],
  );
  const start = useCallback(() => {
    const seed = pickRadioSeed(candidates, Math.random, likedOf);
    if (!seed) return;
    if (seed.kind === "library") startRadio(seed.track);
    else startRadioByName(seed.track.title, seed.track.artist_name, seed.track.album_title);
  }, [candidates, startRadio, startRadioByName, likedOf]);
  return candidates.some(c => likedOf(c.seed) !== -1) ? start : undefined;
}
