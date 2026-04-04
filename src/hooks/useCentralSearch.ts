// src/hooks/useCentralSearch.ts
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, SearchAllResults, SearchResultItem } from "../types";

const DEBOUNCE_MS = 200;
const MAX_TOTAL = 7;
const PER_TYPE_LIMIT = 7; // fetch up to this many per type, trim client-side

interface UseCentralSearchOptions {
  onPlayTrack: (track: Track) => void;
  onEnqueueTrack: (track: Track) => void;
  onCommitSearch: (query: string) => void;
  onNavigateToArtist: (artistId: number) => void;
  onNavigateToAlbum: (albumId: number, artistId: number | null) => void;
}

function allocateSlots(
  artistCount: number,
  albumCount: number,
  trackCount: number,
): { artists: number; albums: number; tracks: number } {
  let a = Math.min(artistCount, 2);
  let b = Math.min(albumCount, 2);
  let t = Math.min(trackCount, 3);

  let remaining = MAX_TOTAL - (a + b + t);

  while (remaining > 0) {
    let distributed = false;
    if (trackCount > t) { t++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (albumCount > b) { b++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (artistCount > a) { a++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (!distributed) break;
  }

  return { artists: a, albums: b, tracks: t };
}

const EMPTY_RESULTS: SearchAllResults = { artists: [], albums: [], tracks: [] };

export function useCentralSearch({
  onPlayTrack,
  onEnqueueTrack,
  onCommitSearch,
  onNavigateToArtist,
  onNavigateToAlbum,
}: UseCentralSearchOptions) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchAllResults>(EMPTY_RESULTS);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const items: SearchResultItem[] = useMemo(() => {
    const list: SearchResultItem[] = [];
    for (const a of results.artists) list.push({ kind: "artist", data: a });
    for (const a of results.albums) list.push({ kind: "album", data: a });
    for (const t of results.tracks) list.push({ kind: "track", data: t });
    return list;
  }, [results]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = query.trim();
    if (!q) {
      setResults(EMPTY_RESULTS);
      setIsOpen(false);
      setHighlightedIndex(-1);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const raw = await invoke<SearchAllResults>("search_all", {
          query: q,
          artistLimit: PER_TYPE_LIMIT,
          albumLimit: PER_TYPE_LIMIT,
          trackLimit: PER_TYPE_LIMIT,
        });
        const slots = allocateSlots(raw.artists.length, raw.albums.length, raw.tracks.length);
        setResults({
          artists: raw.artists.slice(0, slots.artists),
          albums: raw.albums.slice(0, slots.albums),
          tracks: raw.tracks.slice(0, slots.tracks),
        });
        setIsOpen(true);
        setHighlightedIndex(-1);
      } catch (e) {
        console.error("Central search failed:", e);
        setResults(EMPTY_RESULTS);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setResults(EMPTY_RESULTS);
    setHighlightedIndex(-1);
  }, []);

  const actOnItem = useCallback(
    (item: SearchResultItem, enqueue: boolean) => {
      switch (item.kind) {
        case "track":
          if (enqueue) onEnqueueTrack(item.data);
          else onPlayTrack(item.data);
          break;
        case "artist":
          onNavigateToArtist(item.data.id);
          break;
        case "album":
          onNavigateToAlbum(item.data.id, item.data.artist_id);
          break;
      }
    },
    [onPlayTrack, onEnqueueTrack, onNavigateToArtist, onNavigateToAlbum],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen && !query.trim()) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev < items.length - 1 ? prev + 1 : prev
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : -1));
          break;
        case "Enter":
          e.preventDefault();
          if (highlightedIndex >= 0 && highlightedIndex < items.length) {
            actOnItem(items[highlightedIndex], e.metaKey || e.ctrlKey);
            close();
          } else if (query.trim()) {
            onCommitSearch(query.trim());
            close();
          }
          break;
        case "Escape":
          e.preventDefault();
          close();
          break;
      }
    },
    [isOpen, query, items, highlightedIndex, actOnItem, onCommitSearch, close],
  );

  const handleResultClick = useCallback(
    (item: SearchResultItem) => {
      actOnItem(item, false);
      close();
    },
    [actOnItem, close],
  );

  return {
    query,
    setQuery,
    results,
    items,
    isOpen,
    highlightedIndex,
    close,
    handleKeyDown,
    handleResultClick,
  };
}
