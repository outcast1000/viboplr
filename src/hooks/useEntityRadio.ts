import { useCallback } from "react";
import { useDetailActions } from "../contexts/DetailViewContext";
import { pickRadioSeed, type SeedCandidate } from "../utils/radioSeed";

/**
 * The hero Radio button of an artist / album / tag page: picks a weighted
 * random seed from the page's tracks (utils/radioSeed) and starts a station
 * through the canonical radio actions — `startRadio` for a library row,
 * `startRadioByName` for a provider-only one. Returns undefined when there is
 * nothing to seed from, which the hero shows as a disabled button.
 */
export function useEntityRadio(candidates: SeedCandidate[]): (() => void) | undefined {
  const { startRadio, startRadioByName } = useDetailActions();
  const start = useCallback(() => {
    const seed = pickRadioSeed(candidates);
    if (!seed) return;
    if (seed.kind === "library") startRadio(seed.track);
    else startRadioByName(seed.track.title, seed.track.artist_name, seed.track.album_title);
  }, [candidates, startRadio, startRadioByName]);
  return candidates.some(c => c.seed.track.liked !== -1) ? start : undefined;
}
