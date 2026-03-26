// src/hooks/useCentralSearch.ts
import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track } from "../types";

const DEBOUNCE_MS = 200;
const MAX_RESULTS = 8;

interface UseCentralSearchOptions {
  onPlayTrack: (track: Track) => void;
  onCommitSearch: (query: string) => void;
}

export function useCentralSearch({ onPlayTrack, onCommitSearch }: UseCentralSearchOptions) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = query.trim();
    if (!q) {
      setResults([]);
      setIsOpen(false);
      setHighlightedIndex(-1);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const tracks = await invoke<Track[]>("get_tracks", {
          opts: {
            query: q,
            limit: MAX_RESULTS,
            offset: 0,
          },
        });
        setResults(tracks);
        setIsOpen(true);
        setHighlightedIndex(-1);
      } catch (e) {
        console.error("Central search failed:", e);
        setResults([]);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setResults([]);
    setHighlightedIndex(-1);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen && !query.trim()) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev < results.length - 1 ? prev + 1 : prev
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : -1));
          break;
        case "Enter":
          e.preventDefault();
          if (highlightedIndex >= 0 && highlightedIndex < results.length) {
            onPlayTrack(results[highlightedIndex]);
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
    [isOpen, query, results, highlightedIndex, onPlayTrack, onCommitSearch, close]
  );

  const handleResultClick = useCallback(
    (track: Track) => {
      onPlayTrack(track);
      close();
    },
    [onPlayTrack, close]
  );

  return {
    query,
    setQuery,
    results,
    isOpen,
    highlightedIndex,
    close,
    handleKeyDown,
    handleResultClick,
  };
}
