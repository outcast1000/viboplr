import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, Album, Artist, HistoryEntry, HistoryMostPlayed, HistoryArtistStats, QueueTrack } from "../types";
import type {
  HomeShelfDisplayKind,
  HomeShelfResult,
  HomeShelfItem,
  PluginTrack,
} from "../types/plugin";
import type { RecentlyVisitedEntry } from "../utils/recentlyVisited";
import { store } from "../store";

const STALE_MS = 24 * 60 * 60 * 1000;
const PLUGIN_TIMEOUT_MS = 5_000;
const SNAPSHOT_KEY = "homeSnapshot";

interface HomeSnapshot {
  featured: Track[];
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
  currentTrack: QueueTrack | null;
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
  restoredRef: React.RefObject<boolean>;
}

export function shelfKey(pluginId: string | undefined, shelfId: string): string {
  return pluginId ? `${pluginId}:${shelfId}` : `builtin:${shelfId}`;
}

export function useHome(opts: UseHomeOptions) {
  const { isVisible, currentTrack, pluginShelves, invokePluginShelf, pluginsLoaded, visibility, restoredRef } = opts;

  const [featured, setFeatured] = useState<Track[]>([]);
  const [shelves, setShelves] = useState<ResolvedShelf[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const refreshGenRef = useRef(0);
  const featuredRef = useRef<Track[]>([]);
  featuredRef.current = featured;
  const savedAtRef = useRef<number>(0);
  // Resolver ids attempted in the last completed refresh — used to detect
  // freshly-installed plugin shelves that have never been fetched.
  const attemptedKeysRef = useRef<Set<string>>(new Set());

  const fetchFeatured = useCallback(async (): Promise<Track[]> => {
    let anchorTitle: string | null = currentTrack?.title ?? null;
    let anchorArtist: string | null = currentTrack?.artist_name ?? null;

    if (!anchorTitle) {
      try {
        const recent = await invoke<HistoryEntry[]>("get_history_recent", { limit: 1 });
        if (recent[0]) {
          anchorTitle = recent[0].display_title;
          anchorArtist = recent[0].display_artist;
        }
      } catch (e) {
        console.error("Failed to fetch history for featured anchor:", e);
      }
    }

    const STRATEGIES = ["random", "same_artist", "same_tag", "most_played", "liked"] as const;
    const WEIGHTS = [40, 20, 20, 10, 10];
    const total = WEIGHTS.reduce((a, b) => a + b, 0);
    const pickStrategy = () => {
      const roll = Math.floor(Math.random() * total);
      let acc = 0;
      for (let i = 0; i < STRATEGIES.length; i++) {
        acc += WEIGHTS[i];
        if (roll < acc) return STRATEGIES[i];
      }
      return "random";
    };

    const seen = new Set<number>();
    const out: Track[] = [];
    for (let i = 0; i < 20 && out.length < 7; i++) {
      const strat = anchorTitle ? pickStrategy() : "random";
      try {
        const t = await invoke<Track | null>("get_auto_continue_track", {
          strategy: strat,
          currentTitle: anchorTitle,
          currentArtist: anchorArtist,
          formatFilter: null,
        });
        if (t && t.id != null && !seen.has(t.id)) {
          seen.add(t.id);
          out.push(t);
        }
      } catch (e) {
        console.error("Featured pick failed:", e);
      }
    }
    return out;
  }, [currentTrack]);

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
          id: "builtin:radio-stations",
          title: "Radio stations",
          displayKind: "playlist-cards",
          limit: 5,
          fetch: async (limit) => {
            try {
              const seeds = await invoke<Track[]>("pick_radio_seeds", { count: limit });
              if (seeds.length === 0) return { status: "empty" };
              const covers = await Promise.all(seeds.map(async (seed) => {
                if (seed.album_title) {
                  const a = await invoke<string | null>("get_entity_image", { kind: "album", name: seed.album_title, artistName: seed.artist_name ?? null }).catch(() => null);
                  if (a) return a;
                }
                if (seed.artist_name) {
                  const ar = await invoke<string | null>("get_entity_image", { kind: "artist", name: seed.artist_name, artistName: null }).catch(() => null);
                  if (ar) return ar;
                }
                return undefined;
              }));
              return {
                status: "ok",
                items: seeds.map((seed, i) => ({
                  id: `radio:${seed.id}`,
                  name: `Radio: ${seed.title}`,
                  coverUrl: covers[i] ?? undefined,
                  // Sentinel — generation deferred until click; do NOT materialize 30 tracks here.
                  tracks: [{ __radioSeed: { ...seed, image_url: covers[i] ?? seed.image_url } } as unknown as PluginTrack],
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

      const all = [...builtIns, ...pluginResolvers].filter(r =>
        visibility[r.id] !== false,
      );
      // Remember which resolvers we attempted this cycle so a later mount can
      // distinguish an already-seen shelf from a freshly-installed plugin shelf.
      const attemptedKeys = all.map((r) => r.id);
      attemptedKeysRef.current = new Set(attemptedKeys);

      // Featured tracks resolve independently — render them as soon as they arrive.
      const featuredPromise = fetchFeatured().then((feat) => {
        if (gen === refreshGenRef.current) setFeatured(feat);
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

      await Promise.all([featuredPromise, ...shelfPromises]);
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
          featured: featuredRef.current,
          shelves: finalShelves,
          savedAt,
          attemptedKeys,
        }).catch((e) => console.error("Failed to persist home snapshot:", e));
      }
    } finally {
      if (gen === refreshGenRef.current) setIsLoading(false);
    }
  }, [buildBuiltInResolvers, fetchFeatured, invokePluginShelf, pluginShelves, visibility]);

  // Hydrate from the persisted snapshot once, before the first refresh paints anything.
  // This makes a cold launch of Home land on real content instead of an empty state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await store.get<HomeSnapshot>(SNAPSHOT_KEY);
        if (cancelled) return;
        if (snap?.featured?.length) setFeatured(snap.featured);
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
        featured: featuredRef.current,
        shelves: next,
        savedAt: savedAtRef.current,
        attemptedKeys: Array.from(attemptedKeysRef.current),
      }).catch((e) => console.error("Failed to persist pruned home snapshot:", e));
      return next;
    });
  }, [pluginsLoaded, pluginShelves]);

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

  return { featured, shelves, refresh, isLoading };
}
