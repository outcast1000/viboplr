// Mini-player quick search: search state + play/enqueue routing.
//
// Distinct from useCentralSearch: tracks play/enqueue directly. Mini mode has
// no detail pages, so picking an album/artist opens it in the main window
// (the caller leaves mini mode first); the enqueue modifier still enqueues it
// through usePlayActions without leaving the mini player.
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, SearchAllResults, SearchResultItem } from "../types";
import type { SearchLikeDeps } from "../utils/searchLikes";
import { useSearchLikeHandlers } from "./useSearchLikeHandlers";

import { useAssignRef } from "./useLatestRef";
const DEBOUNCE_MS = 200;
// Fixed caps, no redistribution: a sparse category never hands its slots to
// another. Mini search is "find a song fast", so tracks get the most room.
// useMiniMode's MINI_SEARCH_PANEL_HEIGHT is sized to fit exactly these caps.
const ARTIST_LIMIT = 2;
const ALBUM_LIMIT = 2;
const TRACK_LIMIT = 5;
const EMPTY_RESULTS: SearchAllResults = { artists: [], albums: [], tracks: [] };

export interface MiniSearchActionDeps {
  onPlayTrack: (track: Track) => void;
  onEnqueueTrack: (track: Track) => void;
  openAlbum: (albumId: number, artistId: number | null) => void;
  enqueueAlbum: (albumId: number) => void;
  openArtist: (artistId: number) => void;
  enqueueArtist: (artistId: number) => void;
}

// Pure routing core — unit-tested without React.
export function routeMiniSearchAction(
  item: SearchResultItem,
  enqueue: boolean,
  deps: MiniSearchActionDeps,
): void {
  switch (item.kind) {
    case "track":
      if (enqueue) deps.onEnqueueTrack(item.data);
      else deps.onPlayTrack(item.data);
      break;
    case "album":
      if (enqueue) deps.enqueueAlbum(item.data.id);
      else deps.openAlbum(item.data.id, item.data.artist_id);
      break;
    case "artist":
      if (enqueue) deps.enqueueArtist(item.data.id);
      else deps.openArtist(item.data.id);
      break;
  }
}

interface UseMiniSearchOptions extends MiniSearchActionDeps {
  // Called whenever the panel should open/close so useMiniMode can resize the window.
  onOpenPanel: () => void;
  onClosePanel: () => void;
  /** Canonical like handlers (`useLikeActions`). Optional; without them the
   *  panel renders no hearts. */
  likeActions?: SearchLikeDeps;
}

export function useMiniSearch(opts: UseMiniSearchOptions) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchAllResults>(EMPTY_RESULTS);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Keep the latest opts in a ref so callbacks stay stable.
  const optsRef = useRef(opts);
  useAssignRef(optsRef, opts);
  // Hearts on the result rows — see useSearchLikeHandlers.
  const likeHandlers = useSearchLikeHandlers(opts.likeActions, setResults);

  // Flatten results tracks-first (vs. central search's artists-first) — in mini
  // mode, direct track picks are more common than artist/album drilldown.
  const items: SearchResultItem[] = useMemo(() => {
    const list: SearchResultItem[] = [];
    for (const t of results.tracks) list.push({ kind: "track", data: t });
    for (const a of results.albums) list.push({ kind: "album", data: a });
    for (const a of results.artists) list.push({ kind: "artist", data: a });
    return list;
  }, [results]);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setResults(EMPTY_RESULTS);
    setHighlightedIndex(-1);
    optsRef.current.onClosePanel();
  }, []);

  const open = useCallback((initialChar: string) => {
    setQuery(initialChar);
    setResults(EMPTY_RESULTS);
    setHighlightedIndex(-1);
    setIsOpen(true);
    optsRef.current.onOpenPanel();
  }, []);

  // Debounced search. Empty query collapses the panel.
  useEffect(() => {
    if (!isOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = query.trim();
    if (!q) {
      // Field emptied → collapse back to the player.
      close();
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        setResults(await invoke<SearchAllResults>("search_all", {
          query: q,
          artistLimit: ARTIST_LIMIT,
          albumLimit: ALBUM_LIMIT,
          trackLimit: TRACK_LIMIT,
        }));
        setHighlightedIndex(-1);
      } catch (e) {
        console.error("Mini search failed:", e);
        setResults(EMPTY_RESULTS);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, isOpen, close]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev < items.length - 1 ? prev + 1 : prev));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : -1));
          break;
        case "Enter":
          e.preventDefault();
          if (highlightedIndex >= 0 && highlightedIndex < items.length) {
            routeMiniSearchAction(items[highlightedIndex], e.metaKey || e.ctrlKey, optsRef.current);
            close();
          } else if (items.length > 0) {
            // No explicit highlight → act on the first result.
            routeMiniSearchAction(items[0], e.metaKey || e.ctrlKey, optsRef.current);
            close();
          }
          break;
        case "Escape":
          e.preventDefault();
          close();
          break;
      }
    },
    [items, highlightedIndex, close],
  );

  const handleResultClick = useCallback(
    (item: SearchResultItem, enqueue: boolean) => {
      routeMiniSearchAction(item, enqueue, optsRef.current);
      close();
    },
    [close],
  );

  return { query, setQuery, results, items, isOpen, highlightedIndex, open, close, handleKeyDown, handleResultClick, likeHandlers };
}
