import { useRef, useCallback, useState } from "react";
import type { View } from "../types";

export interface NavState {
  view: View;
  selectedArtist: number | null;
  selectedAlbum: number | null;
  selectedTag: number | null;
  selectedTrack?: string | null;
  fallbackArtistName?: string | null;
  fallbackAlbumName?: { name: string; artistName?: string } | null;
  fallbackTrackName?: { name: string; artistName?: string; albumTitle?: string } | null;
  viewSearchQueries: Record<string, string>;
  scrollTop: number;
}

const MAX_HISTORY = 20;

export function useNavigationHistory(
  current: Omit<NavState, "scrollTop">,
  apply: (state: NavState) => void,
  getScrollTop: () => number,
): {
  pushState: () => void;
  goBack: () => void;
  canGoBack: boolean;
} {
  const historyRef = useRef<NavState[]>([]);
  const currentRef = useRef<Omit<NavState, "scrollTop">>(current);
  currentRef.current = current;
  const [, rerender] = useState(0);

  const snap = useCallback((): NavState => ({
    ...currentRef.current,
    scrollTop: getScrollTop(),
  }), [getScrollTop]);

  const pushState = useCallback(() => {
    const s = snap();
    const newHistory = [...historyRef.current, s];
    historyRef.current = newHistory.length > MAX_HISTORY
      ? newHistory.slice(newHistory.length - MAX_HISTORY) : newHistory;
    rerender(n => n + 1);
  }, [snap]);

  const goBack = useCallback(() => {
    if (historyRef.current.length === 0) return;
    const newHistory = [...historyRef.current];
    const target = newHistory.pop()!;
    historyRef.current = newHistory;
    apply(target);
    rerender(n => n + 1);
  }, [apply]);

  return {
    pushState,
    goBack,
    canGoBack: historyRef.current.length > 0,
  };
}
