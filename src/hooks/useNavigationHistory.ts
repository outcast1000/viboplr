import { useRef, useCallback, useState } from "react";
import type { View } from "../types";

export interface NavState {
  view: View;
  selectedArtist: number | null;
  selectedAlbum: number | null;
  selectedTag: number | null;
  selectedTrack?: number | null;
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
  goForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
} {
  const historyRef = useRef<NavState[]>([]);
  const futureRef = useRef<NavState[]>([]);
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
    futureRef.current = [];
    rerender(n => n + 1);
  }, [snap]);

  const goBack = useCallback(() => {
    if (historyRef.current.length === 0) return;
    const newHistory = [...historyRef.current];
    const target = newHistory.pop()!;
    const s = snap();
    historyRef.current = newHistory;
    futureRef.current = [...futureRef.current, s];
    apply(target);
    rerender(n => n + 1);
  }, [apply, snap]);

  const goForward = useCallback(() => {
    if (futureRef.current.length === 0) return;
    const newFuture = [...futureRef.current];
    const target = newFuture.pop()!;
    const s = snap();
    futureRef.current = newFuture;
    historyRef.current = [...historyRef.current, s];
    apply(target);
    rerender(n => n + 1);
  }, [apply, snap]);

  return {
    pushState,
    goBack,
    goForward,
    canGoBack: historyRef.current.length > 0,
    canGoForward: futureRef.current.length > 0,
  };
}
