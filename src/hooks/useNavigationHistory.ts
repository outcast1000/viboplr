import { useEffect, useRef, useCallback, useState } from "react";
import type { View } from "../types";

export interface NavState {
  view: View;
  selectedArtist: number | null;
  selectedAlbum: number | null;
  selectedTag: number | null;
  searchQuery: string;
}

const MAX_HISTORY = 20;

function navStateEqual(a: NavState, b: NavState): boolean {
  return a.view === b.view
    && a.selectedArtist === b.selectedArtist
    && a.selectedAlbum === b.selectedAlbum
    && a.selectedTag === b.selectedTag
    && a.searchQuery === b.searchQuery;
}

export function useNavigationHistory(
  current: NavState,
  setters: {
    setView: (v: View) => void;
    setSelectedArtist: (id: number | null) => void;
    setSelectedAlbum: (id: number | null) => void;
    setSelectedTag: (id: number | null) => void;
    setSearchQuery: (q: string) => void;
  },
): {
  goBack: () => void;
  goForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
} {
  const [history, setHistory] = useState<NavState[]>([]);
  const [future, setFuture] = useState<NavState[]>([]);
  const skipNextPush = useRef(false);
  const prevState = useRef<NavState>(current);
  // Keep searchQuery in sync without triggering history pushes on every keystroke
  prevState.current.searchQuery = current.searchQuery;

  useEffect(() => {
    if (skipNextPush.current) {
      skipNextPush.current = false;
      prevState.current = current;
      return;
    }

    const prev = prevState.current;
    if (navStateEqual(prev, current)) return;

    setHistory(h => {
      const next = [...h, prev];
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
    setFuture([]);
    prevState.current = current;
  }, [current.view, current.selectedArtist, current.selectedAlbum, current.selectedTag]);

  const goBack = useCallback(() => {
    setHistory(h => {
      if (h.length === 0) return h;
      const newHistory = [...h];
      const target = newHistory.pop()!;
      skipNextPush.current = true;
      setFuture(f => [...f, prevState.current]);
      prevState.current = target;
      setters.setView(target.view);
      setters.setSelectedArtist(target.selectedArtist);
      setters.setSelectedAlbum(target.selectedAlbum);
      setters.setSelectedTag(target.selectedTag);
      setters.setSearchQuery(target.searchQuery);
      return newHistory;
    });
  }, [setters.setView, setters.setSelectedArtist, setters.setSelectedAlbum, setters.setSelectedTag, setters.setSearchQuery]);

  const goForward = useCallback(() => {
    setFuture(f => {
      if (f.length === 0) return f;
      const newFuture = [...f];
      const target = newFuture.pop()!;
      skipNextPush.current = true;
      setHistory(h => [...h, prevState.current]);
      prevState.current = target;
      setters.setView(target.view);
      setters.setSelectedArtist(target.selectedArtist);
      setters.setSelectedAlbum(target.selectedAlbum);
      setters.setSelectedTag(target.selectedTag);
      setters.setSearchQuery(target.searchQuery);
      return newFuture;
    });
  }, [setters.setView, setters.setSelectedArtist, setters.setSelectedAlbum, setters.setSelectedTag, setters.setSearchQuery]);

  return {
    goBack,
    goForward,
    canGoBack: history.length > 0,
    canGoForward: future.length > 0,
  };
}
