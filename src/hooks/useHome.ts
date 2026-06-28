import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, Album, Artist, HistoryEntry, HistoryMostPlayed, HistoryArtistStats, LikedEntityInfo } from "../types";
import type {
  HomeShelfDisplayKind,
  HomeShelfResult,
  HomeShelfItem,
} from "../types/plugin";
import type { RecentlyVisitedEntry } from "../utils/recentlyVisited";
import { type RecentPlaySession, sessionKey, sessionSubtitle } from "../utils/recentPlays";
import { store } from "../store";

const STALE_MS = 24 * 60 * 60 * 1000;
const PLUGIN_TIMEOUT_MS = 5_000;
// Coalesce a burst of library changes (e.g. several collections finishing a resync
// back-to-back at startup) into a single background refresh.
const LIBRARY_REFRESH_DEBOUNCE_MS = 1_200;
const SNAPSHOT_KEY = "homeSnapshot";
const RADIO_STATION_COUNT = 7;

// Id of the radio shelf. Unlike the other built-ins it isn't a resolver — its
// items are the radio stations (see buildRadioShelf). Whichever shelf is first
// in the order renders as the Home hero carousel, so by default that's Radio.
export const RADIO_SHELF_ID = "builtin:radio";

// Id of the "Latest play" shelf — recent things that replaced the queue (radio,
// album, artist, tag, track). Its items carry a `__session` (RecentPlaySession);
// clicks/plays are intercepted by id in App.tsx and re-resolved to a fresh play.
export const LATEST_PLAY_SHELF_ID = "builtin:latest-play";

// Canonical built-in shelves in their default order — the single source of truth
// for the standard shelf set (id + title + default order + default visibility).
// The Customize Home modal, the default order, and reset all read from here. The
// curated default shows a focused set (defaultVisible: true) with Radio leading
// as the carousel; the rest are registered but off by default (opt-in).
export const BUILTIN_SHELF_DESCRIPTORS: { id: string; title: string; description: string; defaultVisible: boolean }[] = [
  // Visible by default — the curated Home.
  { id: RADIO_SHELF_ID, title: "Radio", description: "Stations spun from songs you’ll like.", defaultVisible: true },
  { id: LATEST_PLAY_SHELF_ID, title: "Latest play", description: "Jump back into what you last played.", defaultVisible: true },
  { id: "builtin:jump-back-in", title: "Jump back in", description: "Albums and artists you visited recently.", defaultVisible: true },
  { id: "builtin:recently-played", title: "Recently played", description: "Pick up where you left off.", defaultVisible: true },
  { id: "builtin:recently-added", title: "Recently added albums", description: "The newest albums in your library.", defaultVisible: true },
  { id: "builtin:most-played-30d", title: "Most played · 30 days", description: "Your heavy rotation this month.", defaultVisible: true },
  { id: "builtin:discover-by-decade", title: "Discover by decade", description: "A different era from your collection each refresh.", defaultVisible: true },
  { id: "builtin:forgotten-favorites", title: "Forgotten favorites", description: "Old favorites you haven’t played in a while.", defaultVisible: true },
  { id: "builtin:liked-albums", title: "Liked albums", description: "Albums you’ve hearted.", defaultVisible: true },
  // Off by default — opt in via Customize.
  // Track-level counterpart to "Recently added albums": surfaces the newest
  // tracks (including videos, which carry no album_id and so never appear in the
  // album-cards shelf). Opt-in to keep the default Home from double-listing a
  // freshly added album as both cards and rows.
  { id: "builtin:recently-added-tracks", title: "Recently added tracks", description: "The newest tracks in your library, including videos.", defaultVisible: false },
  { id: "builtin:most-played-artists-30d", title: "Most played artists · 30 days", description: "Who you’ve had on repeat lately.", defaultVisible: false },
  { id: "builtin:recently-liked", title: "Recently liked", description: "Songs you’ve loved most recently.", defaultVisible: false },
  { id: "builtin:recently-liked-albums", title: "Recently liked albums", description: "Albums you’ve loved most recently.", defaultVisible: false },
  { id: "builtin:recently-liked-artists", title: "Recently liked artists", description: "Artists you’ve loved most recently.", defaultVisible: false },
  { id: "builtin:random-liked", title: "Random liked", description: "A shuffle through your liked songs.", defaultVisible: false },
  { id: "builtin:liked-artists", title: "Liked artists", description: "Artists you’ve hearted.", defaultVisible: false },
  { id: "builtin:never-played", title: "Never played", description: "Tracks in your library you’ve never played.", defaultVisible: false },
  { id: "builtin:popular-track-radio", title: "Popular Track radio", description: "Stations from your most-played songs.", defaultVisible: false },
  { id: "builtin:liked-track-radio", title: "Liked Track radio", description: "Stations from songs you love.", defaultVisible: false },
];

export const DEFAULT_SHELF_ORDER: string[] = BUILTIN_SHELF_DESCRIPTORS.map((d) => d.id);

// One-line description for a built-in shelf id (shown in the shelf header and the
// Customize modal). Undefined for plugin shelves / unknown ids.
export function shelfDescriptionFor(id: string): string | undefined {
  return BUILTIN_SHELF_DESCRIPTORS.find((d) => d.id === id)?.description;
}

// Effective visibility for a shelf: an explicit user setting (true/false) wins;
// otherwise fall back to the built-in default (plugin shelves default to visible).
export function isShelfVisible(id: string, visibility: Record<string, boolean>): boolean {
  const explicit = visibility[id];
  if (explicit !== undefined) return explicit;
  const d = BUILTIN_SHELF_DESCRIPTORS.find((x) => x.id === id);
  return d ? d.defaultVisible : true;
}

// Merge a persisted shelf order with the canonical default: keep the user's
// arrangement for shelves they've ordered, drop ids no longer known, and slot any
// brand-new built-in (e.g. Radio for a profile saved before it existed) into its
// default position rather than tacking it on the end.
export function mergeShelfOrder(saved: string[], def: string[] = DEFAULT_SHELF_ORDER): string[] {
  const savedSet = new Set(saved);
  const result = saved.filter((id) => def.includes(id));
  for (let i = 0; i < def.length; i++) {
    if (savedSet.has(def[i])) continue;
    result.splice(Math.min(i, result.length), 0, def[i]);
  }
  return result;
}

// Minimal seed metadata a radio station card needs.
interface RadioSeedLike {
  title: string;
  artist_name?: string | null;
  album_title?: string | null;
}

// Build one radio-station card (a playlist-cards item) carrying the `__radioSeed`
// sentinel on its first track, so the existing App.tsx shelf click/play handlers
// route it to startRadio (no special-casing). Shared by the Radio shelf and the
// Popular/Liked track-radio shelves.
function radioStationItem(id: string, seed: RadioSeedLike, coverUrl: string | null): HomeShelfItem {
  return {
    id,
    name: seed.title,
    subtitle: seed.artist_name ?? undefined,
    coverUrl: coverUrl ?? undefined,
    tracks: [
      {
        title: seed.title,
        artist_name: seed.artist_name ?? undefined,
        album_title: seed.album_title ?? undefined,
        image_url: coverUrl ?? undefined,
        __radioSeed: {
          title: seed.title,
          artist_name: seed.artist_name ?? null,
          album_title: seed.album_title ?? null,
          image_url: coverUrl ?? null,
        },
      },
    ],
  } as unknown as HomeShelfItem;
}

// Resolve a cover image (album image first, artist image fallback) for a seed.
// Cache-only lookups via get_entity_image, so it stays well within the shelf budget.
async function resolveCover(
  albumTitle: string | null | undefined,
  artistName: string | null | undefined,
): Promise<string | null> {
  if (albumTitle) {
    const a = await invoke<string | null>("get_entity_image", { kind: "album", name: albumTitle, artistName: artistName ?? null }).catch(() => null);
    if (a) return a;
  }
  if (artistName) {
    const ar = await invoke<string | null>("get_entity_image", { kind: "artist", name: artistName, artistName: null }).catch(() => null);
    if (ar) return ar;
  }
  return null;
}

// Cover for a "Latest play" tile, in priority order:
//   1. the cover captured at play time (s.imagePath),
//   2. name-based re-resolution for the entity the session names (album/artist),
//   3. the lead track's album → artist image (the session keeps `s.track`
//      precisely so we can re-resolve imagery without snapshotting tracks).
// `resolve` is injected (defaults to resolveCover) so this stays unit-testable.
// Returns null → the shelf renders the first-letter placeholder.
export async function resolveSessionCover(
  s: RecentPlaySession,
  resolve: (albumTitle: string | null | undefined, artistName: string | null | undefined) => Promise<string | null> = resolveCover,
): Promise<string | null> {
  if (s.imagePath) return s.imagePath;
  if (s.source === "album") {
    const c = await resolve(s.name, s.artistName);
    if (c) return c;
  } else if (s.source === "artist") {
    const c = await resolve(null, s.name);
    if (c) return c;
  }
  if (s.track) {
    const c = await resolve(s.track.album_title, s.track.artist_name);
    if (c) return c;
  }
  return null;
}

// Build the radio shelf from resolved stations.
export function buildRadioShelf(stations: RadioStation[]): ResolvedShelf {
  return {
    id: RADIO_SHELF_ID,
    title: "Radio",
    displayKind: "playlist-cards",
    items: stations.map((s, i) => radioStationItem(`radio:${i}`, s.seed, s.coverUrl)),
  };
}

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

// Built-in shelves (excluding Radio, which isn't a resolver — its data is the
// independently-fetched radio stations) that are visible but were not attempted
// in the last refresh. This is the built-in counterpart to findUnattemptedShelfKeys:
// a default-off shelf the user just enabled via Customize has never been fetched,
// so its id won't be in `attempted`. Without this, enabling a shelf would leave it
// blank until the 24h staleness window elapsed or the user hit ⟳ Refresh.
export function findUnattemptedBuiltInKeys(
  visibility: Record<string, boolean>,
  attempted: Set<string>,
): string[] {
  return BUILTIN_SHELF_DESCRIPTORS
    .map((d) => d.id)
    .filter((id) => id !== RADIO_SHELF_ID && isShelfVisible(id, visibility) && !attempted.has(id));
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
  // Monotonic counter the host bumps whenever a collection resync changes the
  // library (scan/sync complete). A change re-runs the normal refresh so content
  // shelves (recently added, liked, most-played, …) pick up the new tracks — fully
  // generic, no per-shelf wiring. Debounced and gated so it never delays startup.
  libraryRevision: number;
}

export function shelfKey(pluginId: string | undefined, shelfId: string): string {
  return pluginId ? `${pluginId}:${shelfId}` : `builtin:${shelfId}`;
}

export function useHome(opts: UseHomeOptions) {
  const { isVisible, pluginShelves, invokePluginShelf, pluginsLoaded, visibility, shelfOrder, restoredRef, libraryRevision } = opts;

  const [radioStations, setRadioStations] = useState<RadioStation[]>([]);
  const [shelves, setShelves] = useState<ResolvedShelf[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const refreshGenRef = useRef(0);
  const radioStationsRef = useRef<RadioStation[]>([]);
  radioStationsRef.current = radioStations;
  // Mirror of `shelves` so a refresh can seed itself from what's currently on
  // screen and update shelves in place (rather than collapsing the list and
  // rebuilding it one shelf at a time) — see refresh() below.
  const shelvesRef = useRef<ResolvedShelf[]>(shelves);
  shelvesRef.current = shelves;
  const savedAtRef = useRef<number>(0);
  // Resolver ids attempted in the last completed refresh — used to detect
  // freshly-installed plugin shelves that have never been fetched.
  const attemptedKeysRef = useRef<Set<string>>(new Set());
  // Latest library revision (read via ref so refresh() doesn't depend on it), and
  // the revision the last refresh accounted for. A mismatch means a collection
  // resync landed new tracks that the shelves haven't picked up yet.
  const libRevRef = useRef(libraryRevision);
  libRevRef.current = libraryRevision;
  const refreshedRevRef = useRef(libraryRevision);

  // Pick the radio-station seeds for the hero carousel and resolve a cover image
  // for each (album image first, artist image as fallback). Covers resolve in
  // parallel; a missing cover just renders the letter fallback in the hero.
  const fetchRadioStations = useCallback(async (): Promise<RadioStation[]> => {
    try {
      const seeds = (await invoke<Track[]>("pick_radio_seeds", { count: RADIO_STATION_COUNT })) ?? [];
      if (seeds.length === 0) return [];
      const covers = await Promise.all(seeds.map((seed) => resolveCover(seed.album_title, seed.artist_name)));
      return seeds.map((seed, i) => ({ seed, coverUrl: covers[i] }));
    } catch (e) {
      console.error("Failed to pick radio stations:", e);
      return [];
    }
  }, []);

  const buildBuiltInResolvers = useCallback(
    (recentlyVisited: RecentlyVisitedEntry[], recentPlays: RecentPlaySession[]): ShelfResolver[] => {
      return [
        {
          id: "builtin:recently-played",
          title: "Recently played",
          displayKind: "track-rows",
          limit: 20,
          fetch: async (limit) => {
            try {
              const hist = (await invoke<HistoryEntry[]>("get_history_recent", { limit: 60, resolveAlbums: true })) ?? [];
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
                    // Library-resolved album (history stores none) → album cover
                    // via the shared chain, artist-image fallback when absent.
                    album_title: h.display_album ?? undefined,
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
              const tracks = (await invoke<HistoryMostPlayed[]>("get_history_most_played_since", { sinceTs, limit })) ?? [];
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
              const stats = (await invoke<HistoryArtistStats[]>("get_history_most_played_artists_since", { sinceTs, limit })) ?? [];
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
          title: "Recently added albums",
          displayKind: "album-cards",
          limit: 20,
          fetch: async (limit) => {
            try {
              const albums = (await invoke<Album[]>("get_albums", { artistId: null, sort: "added_desc" })) ?? [];
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
          id: "builtin:recently-added-tracks",
          title: "Recently added tracks",
          // Track-based (not album-based) so videos — which have no album_id —
          // and loose singles surface here. Sorted by tracks.added_at desc.
          displayKind: "track-rows",
          limit: 20,
          fetch: async (limit) => {
            try {
              const tracks = (await invoke<Track[]>("get_tracks", {
                opts: { sortField: "added", sortDir: "desc", limit },
              })) ?? [];
              if (tracks.length === 0) return { status: "empty" };
              return {
                status: "ok",
                items: tracks.map(t => ({
                  track: {
                    title: t.title,
                    artist_name: t.artist_name ?? undefined,
                    album_title: t.album_title ?? undefined,
                    // Carry the real file:// path + duration so the queued track is a
                    // first-class local track (Open Folder / delete-by-path work, native
                    // playback). No image_url: these are library tracks, so their queue
                    // art resolves via the entity cache (avoids a redundant thumb write).
                    path: t.path,
                    duration_secs: t.duration_secs ?? undefined,
                  },
                })),
              };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: "builtin:recently-liked",
          title: "Recently liked",
          displayKind: "track-rows",
          limit: 20,
          fetch: async (limit) => {
            try {
              const rows = (await invoke<LikedEntityInfo[]>("pick_liked_entities", { kind: "track", order: "recent", limit })) ?? [];
              if (rows.length === 0) return { status: "empty" };
              return {
                status: "ok",
                items: rows.map(r => ({
                  track: {
                    title: r.name,
                    artist_name: r.artist_name ?? undefined,
                    album_title: r.album_title ?? undefined,
                    image_url: r.image_url ?? undefined,
                  },
                })),
              };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: "builtin:recently-liked-albums",
          title: "Recently liked albums",
          displayKind: "album-cards",
          limit: 20,
          fetch: async (limit) => {
            try {
              const rows = (await invoke<LikedEntityInfo[]>("pick_liked_entities", { kind: "album", order: "recent", limit })) ?? [];
              if (rows.length === 0) return { status: "empty" };
              // Resolve to library albums by name so cards get a play button + detail nav.
              const items = await Promise.all(rows.map(async (r) => {
                const album = await invoke<Album | null>("find_album_by_name", { title: r.name, artistName: r.artist_name ?? null }).catch(() => null);
                return { libraryId: album?.id, name: r.name, artistName: r.artist_name ?? undefined };
              }));
              return { status: "ok", items };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: "builtin:recently-liked-artists",
          title: "Recently liked artists",
          displayKind: "artist-cards",
          limit: 20,
          fetch: async (limit) => {
            try {
              const rows = (await invoke<LikedEntityInfo[]>("pick_liked_entities", { kind: "artist", order: "recent", limit })) ?? [];
              if (rows.length === 0) return { status: "empty" };
              const items = await Promise.all(rows.map(async (r) => {
                const artist = await invoke<Artist | null>("find_artist_by_name", { name: r.name }).catch(() => null);
                return { libraryId: artist?.id, name: r.name };
              }));
              return { status: "ok", items };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: "builtin:random-liked",
          title: "Random liked",
          displayKind: "track-rows",
          limit: 20,
          fetch: async (limit) => {
            try {
              const rows = (await invoke<LikedEntityInfo[]>("pick_liked_entities", { kind: "track", order: "random", limit })) ?? [];
              if (rows.length === 0) return { status: "empty" };
              return {
                status: "ok",
                items: rows.map(r => ({
                  track: {
                    title: r.name,
                    artist_name: r.artist_name ?? undefined,
                    album_title: r.album_title ?? undefined,
                    image_url: r.image_url ?? undefined,
                  },
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
              const albums = (await invoke<Album[]>("get_albums", { artistId: null, likedOnly: true })) ?? [];
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
              const artists = (await invoke<Artist[]>("get_artists", { likedOnly: true })) ?? [];
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
          id: "builtin:forgotten-favorites",
          title: "Forgotten favorites",
          displayKind: "track-rows",
          limit: 20,
          fetch: async (limit) => {
            try {
              const tracks = (await invoke<Track[]>("pick_forgotten_favorites", { limit })) ?? [];
              if (tracks.length === 0) return { status: "empty" };
              return {
                status: "ok",
                items: tracks.map(t => ({
                  track: { title: t.title, artist_name: t.artist_name ?? undefined, album_title: t.album_title ?? undefined, path: t.path, duration_secs: t.duration_secs ?? undefined },
                })),
              };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: "builtin:never-played",
          title: "Never played",
          displayKind: "track-rows",
          limit: 20,
          fetch: async (limit) => {
            try {
              const tracks = (await invoke<Track[]>("pick_never_played_tracks", { limit })) ?? [];
              if (tracks.length === 0) return { status: "empty" };
              return {
                status: "ok",
                items: tracks.map(t => ({
                  track: { title: t.title, artist_name: t.artist_name ?? undefined, album_title: t.album_title ?? undefined, path: t.path, duration_secs: t.duration_secs ?? undefined },
                })),
              };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: "builtin:discover-by-decade",
          title: "Discover by decade",
          displayKind: "album-cards",
          limit: 20,
          fetch: async (limit) => {
            try {
              const albums = (await invoke<Album[]>("get_albums", { artistId: null })) ?? [];
              const withYear = albums.filter((a) => typeof a.year === "number" && (a.year as number) > 0);
              if (withYear.length === 0) return { status: "empty" };
              // Group by decade, then feature one decade (chosen at random) per refresh.
              const byDecade = new Map<number, Album[]>();
              for (const a of withYear) {
                const d = Math.floor((a.year as number) / 10) * 10;
                const bucket = byDecade.get(d);
                if (bucket) bucket.push(a);
                else byDecade.set(d, [a]);
              }
              const decades = [...byDecade.keys()];
              const decade = decades[Math.floor(Math.random() * decades.length)];
              const picks = [...(byDecade.get(decade) ?? [])];
              for (let i = picks.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [picks[i], picks[j]] = [picks[j], picks[i]];
              }
              return {
                status: "ok",
                items: picks.slice(0, limit).map((a) => ({
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
          id: "builtin:popular-track-radio",
          title: "Popular Track radio",
          displayKind: "playlist-cards",
          limit: 12,
          fetch: async (limit) => {
            try {
              const sinceTs = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
              const tracks = (await invoke<HistoryMostPlayed[]>("get_history_most_played_since", { sinceTs, limit })) ?? [];
              if (tracks.length === 0) return { status: "empty" };
              const items = await Promise.all(
                tracks.map(async (t, i) => {
                  const cover = await resolveCover(null, t.display_artist);
                  return radioStationItem(`radio:pop:${i}`, { title: t.display_title, artist_name: t.display_artist }, cover);
                }),
              );
              return { status: "ok", items };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: "builtin:liked-track-radio",
          title: "Liked Track radio",
          displayKind: "playlist-cards",
          limit: 12,
          fetch: async (limit) => {
            try {
              const rows = (await invoke<LikedEntityInfo[]>("pick_liked_entities", { kind: "track", order: "random", limit })) ?? [];
              if (rows.length === 0) return { status: "empty" };
              const items = await Promise.all(
                rows.map(async (r, i) => {
                  const cover = r.image_url ?? await resolveCover(r.album_title, r.artist_name);
                  return radioStationItem(`radio:liked:${i}`, { title: r.name, artist_name: r.artist_name, album_title: r.album_title }, cover);
                }),
              );
              return { status: "ok", items };
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
                  if (a) items.push({ libraryId: a.id, name: a.title, artistName: a.artist_name ?? undefined, entityKind: "album" });
                } else {
                  const ar = await invoke<Artist | null>("get_artist_by_id", { artistId: v.id });
                  if (ar) items.push({ libraryId: ar.id, name: ar.name, entityKind: "artist" });
                }
              }
              return { status: "ok", items };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: LATEST_PLAY_SHELF_ID,
          title: "Latest play",
          // playlist-cards = "click/play plays it"; App.tsx intercepts by shelf id
          // and re-resolves each `__session` to a fresh play rather than the empty
          // `tracks` we ship here (we don't snapshot the played tracks).
          displayKind: "playlist-cards",
          limit: 12,
          fetch: async (limit) => {
            try {
              const sorted = [...recentPlays].sort((a, b) => b.ts - a.ts).slice(0, limit);
              const items: HomeShelfItem[] = [];
              for (const s of sorted) {
                // Cover chain (cache-only, within the shelf budget): captured
                // cover → named album/artist → lead track's album/artist.
                const cover = await resolveSessionCover(s);
                items.push({
                  id: sessionKey(s),
                  name: s.name,
                  subtitle: sessionSubtitle(s),
                  coverUrl: cover ?? undefined,
                  tracks: [],
                  __session: s,
                } as unknown as HomeShelfItem);
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
    // Capture the library revision this refresh accounts for, up front: its DB
    // reads run after this point, so they observe any resync that has completed.
    refreshedRevRef.current = libRevRef.current;
    setIsLoading(true);
    try {
      const recentlyVisited = (await store.get<RecentlyVisitedEntry[]>("recentlyVisitedEntities")) ?? [];
      const recentPlays = (await store.get<RecentPlaySession[]>("recentPlaySessions")) ?? [];

      const builtIns = buildBuiltInResolvers(recentlyVisited, recentPlays);
      const pluginResolvers: ShelfResolver[] = pluginShelves.map(p => ({
        id: shelfKey(p.pluginId, p.shelfId),
        pluginId: p.pluginId,
        title: p.title,
        displayKind: p.displayKind,
        limit: p.limit,
        fetch: (limit) => invokePluginShelf(p.pluginId, p.shelfId, limit),
      }));

      const all = [...builtIns, ...pluginResolvers]
        .filter(r => isShelfVisible(r.id, visibility))
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
      // Seed the working set from the shelves currently on screen (those still
      // visible this cycle) so a live refresh updates shelves IN PLACE instead of
      // collapsing the list to empty and rebuilding it one shelf at a time. Seeded
      // shelves keep their old items until their resolver returns; any that don't
      // resolve OK this cycle are dropped in the final pass via `resolvedOk`.
      const partial = new Map<string, ResolvedShelf>();
      for (const s of shelvesRef.current) {
        if (order.has(s.id)) partial.set(s.id, s);
      }
      const resolvedOk = new Set<string>();
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
          resolvedOk.add(r.id);
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
        // Final pass: keep only shelves that actually resolved OK this cycle, so a
        // seeded shelf that went ok -> empty/error (or was toggled off) drops in a
        // single clean step at the end rather than flickering mid-refresh.
        const finalShelves = Array.from(partial.values())
          .filter((s) => resolvedOk.has(s.id))
          .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
        setShelves(finalShelves);
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
      findUnattemptedShelfKeys(pluginShelves, visibility, attemptedKeysRef.current).length > 0 ||
      findUnattemptedBuiltInKeys(visibility, attemptedKeysRef.current).length > 0;
    if (savedAtRef.current === 0 || age >= STALE_MS || hasNewShelves) refresh();
  }, [isVisible, refresh, restoredRef, hydrated, pluginsLoaded, pluginShelves, visibility]);

  // Re-run the refresh after a collection resync changes the library (host bumps
  // `libraryRevision`). This is generic — every content shelf picks up the new
  // tracks, not just "Recently added". Gated on restore/hydrate/plugins-loaded so
  // it never runs on the startup critical path, and debounced so several
  // collections finishing back-to-back coalesce into one background refresh.
  //
  // When Home isn't visible we don't fetch: the revision mismatch persists, and
  // because `isVisible` is in the deps this effect re-runs the moment Home opens
  // again, refreshing then. The mismatch is revision-based (not time-based), so a
  // change that lands before hydrate completes is still honoured once `hydrated`
  // flips — no startup race, no dependence on snapshot age.
  useEffect(() => {
    if (!restoredRef.current || !hydrated || !pluginsLoaded) return;
    if (!isVisible) return;
    if (libraryRevision === refreshedRevRef.current) return;
    const t = setTimeout(() => { refresh(); }, LIBRARY_REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [libraryRevision, isVisible, hydrated, pluginsLoaded, restoredRef, refresh]);

  return { radioStations, shelves, refresh, isLoading };
}
