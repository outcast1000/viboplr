// src/hooks/useCentralSearch.ts
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, SearchAllResults, SearchResultItem } from "../types";
import type { PluginSearchProvider, PluginSearchResult, PluginTrack } from "../types/plugin";
import { allocateSlotsBalanced } from "../utils/searchSlots";
import {
  buildPluginSearchSections,
  providerKeyOf,
  type ProviderRunState,
} from "../utils/centralSearchPlugins";

const DEBOUNCE_MS = 200;
const PER_TYPE_LIMIT = 7; // fetch up to this many per type, trim client-side
/** Results to ask a plugin catalog for. Small: these rows sit under the library
 *  results in a dropdown, not in a full results page. */
const PLUGIN_RESULT_LIMIT = 6;

interface UseCentralSearchOptions {
  onPlayTrack: (track: Track) => void;
  onEnqueueTrack: (track: Track) => void;
  onCommitSearch: (query: string) => void;
  onNavigateToArtist: (artistId: number) => void;
  onNavigateToAlbum: (albumId: number, artistId: number | null) => void;
  /** Plugin catalogs the user can ask this search to query. */
  searchProviders: PluginSearchProvider[];
  runProviderSearch: (
    pluginId: string,
    providerId: string,
    query: string,
    limit: number,
  ) => Promise<PluginSearchResult>;
  onPlayPluginTrack: (track: PluginTrack) => void;
  onEnqueuePluginTrack: (track: PluginTrack) => void;
}

const EMPTY_RESULTS: SearchAllResults = { artists: [], albums: [], tracks: [] };

export function useCentralSearch({
  onPlayTrack,
  onEnqueueTrack,
  onCommitSearch,
  onNavigateToArtist,
  onNavigateToAlbum,
  searchProviders,
  runProviderSearch,
  onPlayPluginTrack,
  onEnqueuePluginTrack,
}: UseCentralSearchOptions) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchAllResults>(EMPTY_RESULTS);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Per-provider run state for the CURRENT query only; cleared whenever the
  // query changes. `queryGenRef` is bumped in the same place, so an in-flight
  // provider (these can run for tens of seconds) can tell on return whether the
  // query it was asked about is still the one on screen.
  const [providerStates, setProviderStates] = useState<Record<string, ProviderRunState>>({});
  const queryGenRef = useRef(0);

  // Keep the query and callbacks reachable from runProvider without making it
  // change identity on every keystroke.
  const queryRef = useRef(query);
  queryRef.current = query;
  const runProviderSearchRef = useRef(runProviderSearch);
  runProviderSearchRef.current = runProviderSearch;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = query.trim();
    // A new query invalidates every provider result, including ones still
    // running. Bump first so late arrivals are discarded rather than shown
    // against the wrong query.
    queryGenRef.current++;
    setProviderStates({});

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
        const slots = allocateSlotsBalanced(raw.artists.length, raw.albums.length, raw.tracks.length);
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

  // Ask one plugin catalog about the current query. Only ever reached from an
  // explicit user action (clicking or Entering the provider's offer row).
  const runProvider = useCallback(
    (providerKey: string) => {
      const provider = searchProviders.find((p) => providerKeyOf(p) === providerKey);
      const q = queryRef.current.trim();
      if (!provider || !q) return;
      const gen = queryGenRef.current;
      setProviderStates((prev) => ({ ...prev, [providerKey]: { status: "loading" } }));
      runProviderSearchRef
        .current(provider.pluginId, provider.providerId, q, PLUGIN_RESULT_LIMIT)
        .then((result) => {
          if (gen !== queryGenRef.current) return; // query moved on
          setProviderStates((prev) => ({
            ...prev,
            [providerKey]:
              result.status === "ok"
                ? result.tracks.length > 0
                  ? { status: "done", tracks: result.tracks.slice(0, PLUGIN_RESULT_LIMIT) }
                  : { status: "empty" }
                : result.status === "empty"
                  ? { status: "empty" }
                  : { status: "error", message: result.message },
          }));
        })
        .catch((e) => {
          console.error(`Plugin search "${providerKey}" failed:`, e);
          if (gen !== queryGenRef.current) return;
          setProviderStates((prev) => ({
            ...prev,
            [providerKey]: { status: "error", message: e instanceof Error ? e.message : String(e) },
          }));
        });
    },
    [searchProviders],
  );

  // Library rows first (tracks → albums → artists, matching the mini-player
  // search), then the plugin sections. One flat list so a single highlight index
  // drives the whole dropdown; the sections and the selectable items come from
  // the same walk so their indices can't drift apart.
  const { items, pluginSections } = useMemo(() => {
    const libraryItems: SearchResultItem[] = [];
    for (const t of results.tracks) libraryItems.push({ kind: "track", data: t });
    for (const a of results.albums) libraryItems.push({ kind: "album", data: a });
    for (const a of results.artists) libraryItems.push({ kind: "artist", data: a });

    // Nothing to offer until a query has actually been searched — otherwise the
    // offers would flash up before the library has even been consulted.
    if (!isOpen || searchProviders.length === 0) {
      return { items: libraryItems, pluginSections: [] };
    }

    const { sections, selectable } = buildPluginSearchSections(
      searchProviders,
      providerStates,
      libraryItems.length,
    );
    return { items: [...libraryItems, ...selectable], pluginSections: sections };
  }, [results, isOpen, searchProviders, providerStates]);

  // Running a provider replaces its selectable offer row with an unselectable
  // spinner, so the list can shrink under the highlight — and a highlight past
  // the end silently turns Enter into "commit the search" instead of acting on
  // the row the user thinks is selected.
  useEffect(() => {
    setHighlightedIndex((prev) => (prev >= items.length ? items.length - 1 : prev));
  }, [items.length]);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setResults(EMPTY_RESULTS);
    setHighlightedIndex(-1);
    queryGenRef.current++;
    setProviderStates({});
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
        case "plugin-run":
          runProvider(item.providerKey);
          break;
        case "plugin-track":
          if (enqueue) onEnqueuePluginTrack(item.track);
          else onPlayPluginTrack(item.track);
          break;
      }
    },
    [
      onPlayTrack,
      onEnqueueTrack,
      onNavigateToArtist,
      onNavigateToAlbum,
      runProvider,
      onPlayPluginTrack,
      onEnqueuePluginTrack,
    ],
  );

  /** Activating a provider offer keeps the dropdown open — its results are what
   *  the user asked for and they render in place. Everything else closes. */
  const keepsDropdownOpen = (item: SearchResultItem) => item.kind === "plugin-run";

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
            const item = items[highlightedIndex];
            actOnItem(item, e.metaKey || e.ctrlKey);
            if (!keepsDropdownOpen(item)) close();
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
      if (!keepsDropdownOpen(item)) close();
    },
    [actOnItem, close],
  );

  return {
    query,
    setQuery,
    results,
    items,
    pluginSections,
    isOpen,
    highlightedIndex,
    close,
    handleKeyDown,
    handleResultClick,
  };
}
