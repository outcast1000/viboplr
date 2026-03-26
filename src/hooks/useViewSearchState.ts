// src/hooks/useViewSearchState.ts
import { useState, useCallback, useRef, useEffect } from "react";
import type { View } from "../types";

interface ViewSearchEntry {
  query: string;
  debouncedQuery: string;
}

const DEBOUNCE_MS = 200;

export function useViewSearchState() {
  const [searchStates, setSearchStates] = useState<Map<View, ViewSearchEntry>>(
    () => new Map()
  );
  const timersRef = useRef<Map<View, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  const getEntry = useCallback(
    (view: View): ViewSearchEntry => {
      return searchStates.get(view) ?? { query: "", debouncedQuery: "" };
    },
    [searchStates]
  );

  const getQuery = useCallback(
    (view: View): string => getEntry(view).query,
    [getEntry]
  );

  const getDebouncedQuery = useCallback(
    (view: View): string => getEntry(view).debouncedQuery,
    [getEntry]
  );

  const setQuery = useCallback((view: View, query: string) => {
    setSearchStates((prev) => {
      const next = new Map(prev);
      const existing = prev.get(view);
      next.set(view, {
        query,
        debouncedQuery: existing?.debouncedQuery ?? "",
      });
      return next;
    });

    const existingTimer = timersRef.current.get(view);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      setSearchStates((prev) => {
        const next = new Map(prev);
        const existing = prev.get(view);
        if (existing) {
          next.set(view, { ...existing, debouncedQuery: query });
        }
        return next;
      });
      timersRef.current.delete(view);
    }, DEBOUNCE_MS);

    timersRef.current.set(view, timer);
  }, []);

  const clearQuery = useCallback((view: View) => {
    const existingTimer = timersRef.current.get(view);
    if (existingTimer) {
      clearTimeout(existingTimer);
      timersRef.current.delete(view);
    }
    setSearchStates((prev) => {
      const next = new Map(prev);
      next.set(view, { query: "", debouncedQuery: "" });
      return next;
    });
  }, []);

  const snapshot = useCallback((): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const [view, entry] of searchStates) {
      if (entry.query) result[view] = entry.query;
    }
    return result;
  }, [searchStates]);

  const restore = useCallback((data: Record<string, string>) => {
    for (const timer of timersRef.current.values()) {
      clearTimeout(timer);
    }
    timersRef.current.clear();

    const next = new Map<View, ViewSearchEntry>();
    for (const [view, query] of Object.entries(data)) {
      next.set(view as View, { query, debouncedQuery: query });
    }
    setSearchStates(next);
  }, []);

  return {
    getQuery,
    getDebouncedQuery,
    setQuery,
    clearQuery,
    snapshot,
    restore,
  };
}
