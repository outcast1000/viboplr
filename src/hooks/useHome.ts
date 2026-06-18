import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, Album, Artist, HistoryEntry, HistoryMostPlayed, HistoryArtistStats } from "../types";
import type {
  HomeShelfDisplayKind,
  HomeShelfResult,
  HomeShelfItem,
} from "../types/plugin";
import type { RecentlyVisitedEntry } from "../utils/recentlyVisited";
import { store } from "../store";

const STALE_MS = 24 * 60 * 60 * 1000;
const PLUGIN_TIMEOUT_MS = 5_000;
const SNAPSHOT_KEY = "homeSnapshot";
const RADIO_STATION_COUNT = 7;

// Canonical built-in shelves in their default order — the single source of truth
// for the standard shelf set (id + title + order). `buildBuiltInResolvers` builds
// its resolver array in this same order; the Customize Home modal and the default
// reset both read from here.
export const BUILTIN_SHELF_DESCRIPTORS: { id: string; title: string }[] = [
  { id: "builtin:recently-played", title: "Recently played" },
  { id: "builtin:most-played-30d", title: "Most played · 30 days" },
  { id: "builtin:most-played-artists-30d", title: "Most played artists · 30 days" },
  { id: "builtin:recently-added", title: "Recently added" },
  { id: "builtin:liked-albums", title: "Liked albums" },
  { id: "builtin:liked-artists", title: "Liked artists" },
  { id: "builtin:jump-back-in", title: "Jump back in" },
];

export const DEFAULT_SHELF_ORDER: string[] = BUILTIN_SHELF_DESCRIPTORS.map((d) => d.id);

// A radio station shown in the hero carousel: a seed track plus its resolved
// cover (album image, falling back to artist image).
export interface RadioStation {
  seed: Track;
  coverUrl: string | null;
}

interface HomeSnapshot {
  radioStations: RadioStation[];
  shelves: ResolvedShelf[];
  savedAt?: number;
  // Resolver ids attempted in the last refresh (built-in + visible plugin
  // shelves). Persisted so a later mount can tell an already-seen plugin shelf
  // from a freshly installed one without re-fetching everything.
  attemptedKeys?: string[];
}

// Plugin shelves that are visible but have never been fetched (their key is not
// in `attempted`). A non-empty result means a refresh is warranted even when the
// snapshot is otherwise fresh — e.g. right after installing a plugin from the
// gallery, or toggling a never-fetched shelf on.
export function findUnattemptedShelfKeys(
  pluginShelves: Array<{ pluginId: string; shelfId: string }>,
  visibility: Record<string, boolean>,
  attempted: Set<string>,
): string[] {
  return pluginShelves
    .map((p) => shelfKey(p.pluginId, p.shelfId))
    .filter((id) => visibility[id] !== false && !attempted.has(id));
}

export interface ResolvedShelf {
  id: string;
  pluginId?: string;
  title: string;
  displayKind: HomeShelfDisplayKind;
  items: HomeShelfItem[];
}

export interface ShelfResolver {
  id: string;
  pluginId?: string;
  title: string;
  displayKind: HomeShelfDisplayKind;
  limit: number;
  fetch: (limit: number) => Promise<HomeShelfResult>;
}

// Sort key for a shelf given the user's built-in order. Built-ins are ranked by
// their position in `builtinOrder`; an unknown/new built-in (not yet in the saved
// order, e.g. added in a later release) sorts just after the listed built-ins;
// plugin shelves always come after all built-ins. Stable sorts preserve the input
// order among same-rank items (so plugins and unknown built-ins keep their order).
function rankShelf(item: { id: string; pluginId?: string }, builtinOrder: string[]): number {
  if (item.pluginId) return builtinOrder.length + 1;
  const idx = builtinOrder.indexOf(item.id);
  return idx >= 0 ? idx : builtinOrder.length;
}

// Reorder resolved shelves so the built-in ones follow `builtinOrder`. Pure —
// used both when refreshing and to re-sort live when the user reorders shelves.
export function orderResolvedShelves(
  shelves: ResolvedShelf[],
  builtinOrder: string[],
): ResolvedShelf[] {
  return [...shelves].sort((a, b) => rankShelf(a, builtinOrder) - rankShelf(b, builtinOrder));
}

export async function resolveShelves(
  resolvers: ShelfResolver[],
  opts: { timeoutMs: number } = { timeoutMs: PLUGIN_TIMEOUT_MS },
): Promise<ResolvedShelf[]> {
  const work = resolvers.map(async (r) => {
    try {
      const result = await Promise.race<HomeShelfResult>([
        r.fetch(r.limit),
        new Promise<HomeShelfResult>((resolve) =>
          setTimeout(() => resolve({ status: "error", message: "timeout" }), opts.timeoutMs),
        ),
      ]);
      if (result.status !== "ok" || result.items.length === 0) {
        if (result.status === "error") {
          console.error(`Home shelf "${r.id}" failed:`, result.message ?? "");
        }
        return null;
      }
      return {
        id: r.id,
        pluginId: r.pluginId,
        title: r.title,
        displayKind: r.displayKind,
        items: result.items,
      } as ResolvedShelf;
    } catch (e) {
      console.error(`Home shelf "${r.id}" threw:`, e);
      return null;
    }
  });
  const settled = await Promise.all(work);
  return settled.filter((s): s is ResolvedShelf => s !== null);
}

export interface UseHomeOptions {
  isVisible: boolean;
  pluginShelves: Array<{
    pluginId: string;
    shelfId: string;
    title: string;
    displayKind: HomeShelfDisplayKind;
    limit: number;
  }>;
  invokePluginShelf: (
    pluginId: string,
    shelfId: string,
    limit: number,
  ) => Promise<HomeShelfResult>;
  pluginsLoaded: boolean;
  visibility: Record<string, boolean>;
  // User-defined order of the built-in shelves (ids). Plugin shelves always
  // follow the built-ins regardless. Defaults to DEFAULT_SHELF_ORDER.
  shelfOrder: string[];
  restoredRef: React.RefObject<boolean>;
}

export function shelfKey(pluginId: string | undefined, shelfId: string): string {
  return pluginId ? `${pluginId}:${shelfId}` : `builtin:${shelfId}`;
}

export function useHome(opts: UseHomeOptions) {
  const { isVisible, pluginShelves, invokePluginShelf, pluginsLoaded, visibility, shelfOrder, restoredRef } = opts;

  const [radioStations, setRadioStations] = useState<RadioStation[]>([]);
  const [shelves, setShelves] = useState<ResolvedShelf[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const refreshGenRef = useRef(0);
  const radioStationsRef = useRef<RadioStation[]>([]);
  radioStationsRef.current = radioStations;
  const savedAtRef = useRef<number>(0);
  // Resolver ids attempted in the last completed refresh — used to detect
  // freshly-installed plugin shelves that have never been fetched.
  const attemptedKeysRef = useRef<Set<string>>(new Set());

  // Pick the radio-station seeds for the hero carousel and resolve a cover image
  // for each (album image first, artist image as fallback). Covers resolve in
  // parallel; a missing cover just renders the letter fallback in the hero.
  const fetchRadioStations = useCallback(async (): Promise<RadioStation[]> => {
    try {
      const seeds = await invoke<Track[]>("pick_radio_seeds", { count: RADIO_STATION_COUNT });
      if (seeds.length === 0) return [];
      const covers = await Promise.all(seeds.map(async (seed) => {
        if (seed.album_title) {
          const a = await invoke<string | null>("get_entity_image", { kind: "album", name: seed.album_title, artistName: seed.artist_name ?? null }).catch(() => null);
          if (a) return a;
        }
        if (seed.artist_name) {
          const ar = await invoke<string | null>("get_entity_image", { kind: "artist", name: seed.artist_name, artistName: null }).catch(() => null);
          if (ar) return ar;
        }
        return null;
      }));
      return seeds.map((seed, i) => ({ seed, coverUrl: covers[i] }));
    } catch (e) {
      console.error("Failed to pick radio stations:", e);
      return [];
    }
  }, []);

  const buildBuiltInResolvers = useCallback(
    (recentlyVisited: RecentlyVisitedEntry[]): ShelfResolver[] => {
      return [
        {
          id: "builtin:recently-played",
          title: "Recently played",
          displayKind: "track-rows",
          limit: 20,
          fetch: async (limit) => {
            try {
              const hist = await invoke<HistoryEntry[]>("get_history_recent", { limit: 60 });
              const seen = new Set<string>();
              const items: HomeShelfItem[] = [];
              for (const h of hist) {
                const key = `${h.display_artist ?? ""}|${h.display_title}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({
                  track: {
                    title: h.display_title,
                    artist_name: h.display_artist ?? undefined,
                  },
                });
                if (items.length >= limit) break;
              }
              return { status: "ok", items };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: "builtin:most-played-30d",
          title: "Most played · 30 days",
          displayKind: "track-rows",
          limit: 20,
          fetch: async (limit) => {
            try {
              const sinceTs = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
              const tracks = await invoke<HistoryMostPlayed[]>("get_history_most_played_since", { sinceTs, limit });
              return {
                status: "ok",
                items: tracks.map(t => ({
                  track: {
                    title: t.display_title,
                    artist_name: t.display_artist ?? undefined,
                  },
                })),
              };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: "builtin:most-played-artists-30d",
          title: "Most played artists · 30 days",
          displayKind: "artist-cards",
          limit: 20,
          fetch: async (limit) => {
            try {
              const sinceTs = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
              const stats = await invoke<HistoryArtistStats[]>("get_history_most_played_artists_since", { sinceTs, limit });
              if (stats.length === 0) return { status: "empty" };
              // Resolve to library artists via the backend (which normalizes diacritics)
              // so cards navigate to detail pages even when accent forms differ.
              const resolved = await Promise.all(
                stats.map(async (s) => {
                  try {
                    const a = await invoke<Artist | null>("find_artist_by_name", { name: s.display_name });
                    return { libraryId: a?.id, name: s.display_name };
                  } catch (e) {
                    console.error("Failed to resolve home shelf artist:", e);
                    return { name: s.display_name };
                  }
                }),
              );
              return { status: "ok", items: resolved };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: "builtin:recently-added",
          title: "Recently added",
          displayKind: "album-cards",
          limit: 20,
          fetch: async (limit) => {
            try {
              const albums = await invoke<Album[]>("get_albums", { artistId: null, sort: "added_desc" });
              return {
                status: "ok",
                items: albums.slice(0, limit).map(a => ({
                  libraryId: a.id,
                  name: a.title,
                  artistName: a.artist_name ?? undefined,
                })),
              };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: "builtin:liked-albums",
          title: "Liked albums",
          displayKind: "album-cards",
          limit: 20,
          fetch: async (limit) => {
            try {
              const albums = await invoke<Album[]>("get_albums", { artistId: null, likedOnly: true });
              return {
                status: "ok",
                items: albums.slice(0, limit).map(a => ({
                  libraryId: a.id,
                  name: a.title,
                  artistName: a.artist_name ?? undefined,
                })),
              };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: "builtin:liked-artists",
          title: "Liked artists",
          displayKind: "artist-cards",
          limit: 20,
          fetch: async (limit) => {
            try {
              const artists = await invoke<Artist[]>("get_artists", { likedOnly: true });
              return {
                status: "ok",
                items: artists.slice(0, limit).map(a => ({
                  libraryId: a.id,
                  name: a.name,
                })),
              };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: "builtin:jump-back-in",
          title: "Jump back in",
          displayKind: "album-cards",
          limit: 12,
          fetch: async (limit) => {
            try {
              const sorted = [...recentlyVisited].sort((a, b) => b.ts - a.ts).slice(0, limit);
              const items: HomeShelfItem[] = [];
              for (const v of sorted) {
                if (v.kind === "album") {
                  const a = await invoke<Album | null>("get_album_by_id", { albumId: v.id });
                  if (a) items.push({ libraryId: a.id, name: a.title, artistName: a.artist_name ?? undefined });
                } else {
                  const ar = await invoke<Artist | null>("get_artist_by_id", { artistId: v.id });
                  if (ar) items.push({ libraryId: ar.id, name: ar.name });
                }
              }
              return { status: "ok", items };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
      ];
    },
    [],
  );

  const refresh = useCallback(async () => {
    const gen = ++refreshGenRef.current;
    setIsLoading(true);
    try {
      const recentlyVisited = (await store.get<RecentlyVisitedEntry[]>("recentlyVisitedEntities")) ?? [];

      const builtIns = buildBuiltInResolvers(recentlyVisited);
      const pluginResolvers: ShelfResolver[] = pluginShelves.map(p => ({
        id: shelfKey(p.pluginId, p.shelfId),
        pluginId: p.pluginId,
        title: p.title,
        displayKind: p.displayKind,
        limit: p.limit,
        fetch: (limit) => invokePluginShelf(p.pluginId, p.shelfId, limit),
      }));

      const all = [...builtIns, ...pluginResolvers]
        .filter(r => visibility[r.id] !== false)
        // Apply the user's built-in order; plugin shelves stay after the built-ins.
        .sort((a, b) => rankShelf(a, shelfOrder) - rankShelf(b, shelfOrder));
      // Remember which resolvers we attempted this cycle so a later mount can
      // distinguish an already-seen shelf from a freshly-installed plugin shelf.
      const attemptedKeys = all.map((r) => r.id);
      attemptedKeysRef.current = new Set(attemptedKeys);

      // Radio stations resolve independently — render them as soon as they arrive.
      const radioPromise = fetchRadioStations().then((stations) => {
        if (gen === refreshGenRef.current) setRadioStations(stations);
      });

      // Stream each shelf into the UI as it resolves, preserving the resolver order.
      const order = new Map(all.map((r, i) => [r.id, i]));
      const partial = new Map<string, ResolvedShelf>();
      const shelfPromises = all.map(async (r) => {
        try {
          const result = await Promise.race<HomeShelfResult>([
            r.fetch(r.limit),
            new Promise<HomeShelfResult>((resolve) =>
              setTimeout(() => resolve({ status: "error", message: "timeout" }), PLUGIN_TIMEOUT_MS),
            ),
          ]);
          if (gen !== refreshGenRef.current) return;
          if (result.status !== "ok" || result.items.length === 0) {
            if (result.status === "error") {
              console.error(`Home shelf "${r.id}" failed:`, result.message ?? "");
            }
            return;
          }
          partial.set(r.id, {
            id: r.id,
            pluginId: r.pluginId,
            title: r.title,
            displayKind: r.displayKind,
            items: result.items,
          });
          const next = Array.from(partial.values()).sort(
            (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
          );
          setShelves(next);
        } catch (e) {
          console.error(`Home shelf "${r.id}" threw:`, e);
        }
      });

      await Promise.all([radioPromise, ...shelfPromises]);
      if (gen === refreshGenRef.current) {
        // Final pass: drop any shelves left over from a previous run that no longer
        // resolved this cycle (e.g., went from ok -> empty/error or were toggled off).
        const finalIds = new Set(partial.keys());
        const finalShelves = Array.from(partial.values()).sort(
          (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
        );
        setShelves((prev) => prev.filter((s) => finalIds.has(s.id)));
        // Persist the snapshot so the next mount can hydrate instantly.
        const savedAt = Date.now();
        savedAtRef.current = savedAt;
        store.set(SNAPSHOT_KEY, {
          radioStations: radioStationsRef.current,
          shelves: finalShelves,
          savedAt,
          attemptedKeys,
        }).catch((e) => console.error("Failed to persist home snapshot:", e));
      }
    } finally {
      if (gen === refreshGenRef.current) setIsLoading(false);
    }
  }, [buildBuiltInResolvers, fetchRadioStations, invokePluginShelf, pluginShelves, visibility, shelfOrder]);

  // Hydrate from the persisted snapshot once, before the first refresh paints anything.
  // This makes a cold launch of Home land on real content instead of an empty state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await store.get<HomeSnapshot>(SNAPSHOT_KEY);
        if (cancelled) return;
        if (snap?.radioStations?.length) setRadioStations(snap.radioStations);
        if (snap?.shelves?.length) setShelves(snap.shelves);
        if (snap?.savedAt) savedAtRef.current = snap.savedAt;
        if (snap?.attemptedKeys) attemptedKeysRef.current = new Set(snap.attemptedKeys);
      } catch (e) {
        console.error("Failed to hydrate home snapshot:", e);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Prune hydrated shelves whose plugin is no longer loaded (e.g. the plugin was
  // uninstalled/removed since the snapshot was saved). Built-in shelves (no
  // pluginId) are never pruned. Gated on pluginsLoaded so we don't drop valid
  // plugin shelves during the async load window — an empty pluginShelves there
  // means "not loaded yet", not "gone". This complements the 24h refresh gate:
  // without it, a removed plugin's shelves would linger from cache until refresh.
  useEffect(() => {
    if (!pluginsLoaded) return;
    const liveShelfIds = new Set(
      pluginShelves.map((p) => shelfKey(p.pluginId, p.shelfId)),
    );
    setShelves((prev) => {
      const next = prev.filter((s) => !s.pluginId || liveShelfIds.has(s.id));
      if (next.length === prev.length) return prev;
      // Re-persist the pruned snapshot (keeping the existing savedAt so the 24h
      // refresh schedule is unaffected) so a removed plugin's shelves don't
      // re-hydrate and flash on the next cold launch.
      store.set(SNAPSHOT_KEY, {
        radioStations: radioStationsRef.current,
        shelves: next,
        savedAt: savedAtRef.current,
        attemptedKeys: Array.from(attemptedKeysRef.current),
      }).catch((e) => console.error("Failed to persist pruned home snapshot:", e));
      return next;
    });
  }, [pluginsLoaded, pluginShelves]);

  // Reorder the already-resolved shelves in place when the user changes the
  // built-in order. Reordering is pure presentation, so this never refetches.
  useEffect(() => {
    setShelves((prev) => {
      const next = orderResolvedShelves(prev, shelfOrder);
      if (next.every((s, i) => s.id === prev[i]?.id)) return prev;
      return next;
    });
  }, [shelfOrder]);

  // Refresh on mount when the cached snapshot is older than 24h (or absent), OR
  // when a visible plugin shelf has never been fetched (e.g. a plugin was just
  // installed from the gallery). The staleness gate alone would otherwise leave
  // a freshly-installed plugin's shelf invisible until the 24h window elapsed or
  // the user hit ⟳ Refresh manually. Manual refresh stays available regardless.
  // Gated on `pluginsLoaded` so the async plugin-load window (where pluginShelves
  // is transiently empty) doesn't read as "nothing new".
  useEffect(() => {
    if (!isVisible || !restoredRef.current || !hydrated || !pluginsLoaded) return;
    const age = Date.now() - savedAtRef.current;
    const hasNewShelves =
      findUnattemptedShelfKeys(pluginShelves, visibility, attemptedKeysRef.current).length > 0;
    if (savedAtRef.current === 0 || age >= STALE_MS || hasNewShelves) refresh();
  }, [isVisible, refresh, restoredRef, hydrated, pluginsLoaded, pluginShelves, visibility]);

  return { radioStations, shelves, refresh, isLoading };
}
