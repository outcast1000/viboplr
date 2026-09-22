// Row hearts for the two quick-search surfaces (caption-bar dropdown, mini
// panel). Both hooks hold a transient `SearchAllResults`; this gives them the
// row-level handlers that patch that snapshot and then run the canonical
// `useLikeActions` write — see utils/searchLikes.ts for the pure half.
//
// The deps object is rebuilt by App on every render, so it goes through
// `useStableCallbacks`: the returned handlers keep one identity (the mini
// panel's props are memoized on it) while dispatching to the latest closures.
import { useMemo } from "react";
import type { SearchAllResults } from "../types";
import { useStableCallbacks } from "./useStableCallbacks";
import { buildSearchLikeHandlers, type SearchLikeDeps, type SearchLikeHandlers } from "../utils/searchLikes";

// Stands in when no deps are wired so the key set the wrapper fixes on its
// first render is always the full one (see useStableCallbacks' rules).
const NO_DEPS: SearchLikeDeps = {
  onToggleTrackLike: () => {},
  onToggleTrackDislike: () => {},
  onToggleArtistLike: () => {},
  onToggleArtistDislike: () => {},
  onToggleAlbumLike: () => {},
  onToggleAlbumDislike: () => {},
};

export function useSearchLikeHandlers(
  deps: SearchLikeDeps | undefined,
  setResults: React.Dispatch<React.SetStateAction<SearchAllResults>>,
): SearchLikeHandlers | undefined {
  const stable = useStableCallbacks(deps ?? NO_DEPS);
  const hasDeps = deps !== undefined;
  return useMemo(
    () => buildSearchLikeHandlers(hasDeps ? stable : undefined, setResults),
    [hasDeps, stable, setResults],
  );
}
