import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, Album, Artist, HistoryEntry, HistoryMostPlayed, HistoryArtistStats, LikedEntityInfo } from "../types";
import type {
  HomeShelfDisplayKind,
  HomeShelfResult,
  HomeShelfItem,
  PluginTrack,
} from "../types/plugin";
import type { RecentlyVisitedEntry } from "../utils/recentlyVisited";
import { type RecentPlaySession, sessionKey, sessionSubtitle } from "../utils/recentPlays";
import { store } from "../store";
import { isVideoTrack } from "../utils";
import { isLocalTrack, type PlaylistTrackRow } from "../queueEntry";

import { useAssignRef } from "./useLatestRef";
import { coerceSeedCooldown, rememberShownSeeds } from "../utils/radioSeedCooldown";
const STALE_MS = 24 * 60 * 60 * 1000;
const PLUGIN_TIMEOUT_MS = 5_000;
// Coalesce a burst of library changes (e.g. several collections finishing a resync
// back-to-back at startup) into a single background refresh.
const LIBRARY_REFRESH_DEBOUNCE_MS = 1_200;
const SNAPSHOT_KEY = "homeSnapshot";
// Ring of radio seed ids shown over the last few refreshes (utils/radioSeedCooldown).
const RADIO_SEED_COOLDOWN_KEY = "radioSeedCooldown";
// Five familiar + five discovery seeds (the backend splits `count` half/half —
// see `radio_seed_quotas` in db/history.rs).
const RADIO_STATION_COUNT = 10;

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
  { id: "builtin:recently-added", title: "Recently added albums", description: "The newest albums in your library.", defaultVisible: true },
  { id: "builtin:most-played-30d", title: "Most played · 30 days", description: "Your heavy rotation this month.", defaultVisible: true },
  { id: "builtin:discover-by-decade", title: "Discover by decade", description: "A mix from each era in your collection.", defaultVisible: true },
  { id: "builtin:forgotten-favorites", title: "Forgotten favorites", description: "Mixes of old favorites you haven’t played in a while.", defaultVisible: true },
  // Shuffled, not alphabetical — a 20-card view of an A→Z list showed the same
  // "A" albums on every refresh. "Recently liked albums" covers the by-date view.
  { id: "builtin:liked-albums", title: "Liked albums", description: "A shuffle through albums you’ve hearted.", defaultVisible: true },
  // Last of the defaults: right under Latest play / Jump back in it read as a
  // third "recent" shelf in a row.
  { id: "builtin:recently-played", title: "Recently played", description: "Pick up where you left off.", defaultVisible: true },
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
  { id: "builtin:liked-artists", title: "Liked artists", description: "A shuffle through artists you’ve hearted.", defaultVisible: false },
  { id: "builtin:never-played", title: "Never played", description: "Tracks in your library you’ve never played.", defaultVisible: false },
  // No "Popular / Liked track radio" shelves: they were narrower slices of the
  // Radio carousel's familiar half (most-played / liked tracks as stations)
  // without its one-per-artist rule or shown-seed cooldown, and each repeated
  // an existing shelf (Most played · 30 days / Random liked). More stations
  // belong in the carousel, not in a second station row.
];

export const DEFAULT_SHELF_ORDER: string[] = BUILTIN_SHELF_DESCRIPTORS.map((d) => d.id);

// A forgotten-favorites mix from the backend (`TrackMix` in models.rs),
// grouped by `tag` (null = the catch-all).
export interface TrackMix {
  tag: string | null;
  tracks: Track[];
}

// Six forgotten mixes keeps the row to about a screen.
const FORGOTTEN_MIX_COUNT = 6;
const MIX_SIZE = 25;

// The Playlists view's auto decade mixes (`auto_playlists.rs`), which the
// "Discover by decade" shelf shows instead of building decade mixes of its own,
// so there is one "1990s" mix across the app.
const AUTO_DECADE_KIND_PREFIX = "auto:decade:";

// The slice of a playlist row (`Playlist` in models.rs) the decade shelf reads.
export interface DecadePlaylistRow {
  id: number;
  name: string;
  image_path: string | null;
  track_count: number;
  system_kind: string | null;
}

// The auto decade playlists among `rows`, oldest decade first. The kind is
// `auto:decade:1990s`; its number is the sort key.
export function decadePlaylists<T extends DecadePlaylistRow>(rows: T[]): T[] {
  const decadeOf = (p: T) => Number.parseInt((p.system_kind ?? "").slice(AUTO_DECADE_KIND_PREFIX.length), 10);
  return rows
    .filter((p) => p.system_kind?.startsWith(AUTO_DECADE_KIND_PREFIX) && Number.isFinite(decadeOf(p)))
    .sort((a, b) => decadeOf(a) - decadeOf(b));
}
// How many "Latest play" cards the shelf shows (and so how many sessions
// "Jump back in" checks itself against).
const LATEST_PLAY_LIMIT = 12;
// Recent plays read to fill "Recently played". Repeats are dropped, so reading
// exactly 20 left a short shelf for anyone who had looped one album.
const RECENTLY_PLAYED_SCAN = 200;

// Card names stand alone, because the same name becomes the queue banner once
// the mix plays — "Jazz" there says nothing about where the tracks came from.
export function forgottenMixName(tag: string | null): string {
  return tag ? `Forgotten ${tag}` : "Forgotten favorites mix";
}
export function trackCountLabel(n: number): string {
  return `${n} ${n === 1 ? "track" : "tracks"}`;
}

// A playlist row's track as a shelf track. `source` is the track's own URI.
export function playlistShelfTrack(t: PlaylistTrackRow): PluginTrack {
  return {
    title: t.title,
    artist_name: t.artist_name ?? undefined,
    album_title: t.album_name ?? undefined,
    duration_secs: t.duration_secs ?? undefined,
    path: t.source ?? undefined,
    image_url: t.image_path ?? undefined,
  };
}

// A library track as a shelf track: the real path + duration, so the queued
// entry is first-class (Open Folder, delete-by-path, native playback). No
// image_url — library art resolves through the entity cache.
export function libraryShelfTrack(t: Track): PluginTrack {
  return {
    title: t.title,
    artist_name: t.artist_name ?? undefined,
    album_artist_name: t.album_artist_name ?? undefined,
    album_title: t.album_title ?? undefined,
    path: t.path,
    duration_secs: t.duration_secs ?? undefined,
  };
}

// "Jump back in" leaves out an album or artist the user also played, when that
// play is on the Latest play shelf: opening a card and pressing play put the
// same entity on both shelves. Matched by name, case-insensitively — both sides
// are display names already in hand, not a library lookup.
export function visitAlreadyInLatestPlay(
  item: { name: string; artistName?: string; entityKind?: "album" | "artist" },
  sessions: RecentPlaySession[],
): boolean {
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLocaleLowerCase();
  const name = norm(item.name);
  return sessions.some((s) => {
    if (norm(s.name) !== name) return false;
    if (item.entityKind === "artist") return s.source === "artist";
    if (s.source !== "album") return false;
    // An album session without an artist (or a card without one) still matches.
    return !s.artistName || !item.artistName || norm(s.artistName) === norm(item.artistName);
  });
}

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

// Drop built-in shelves (no pluginId) whose id is no longer a descriptor — a
// shelf removed in a later release. Without this a hydrated snapshot keeps
// rendering it until the next refresh (up to 24h): `isShelfVisible` reads an
// unknown id as visible (the plugin default) and the prune effect only prunes
// plugin shelves. Plugin shelves pass through untouched.
export function dropRetiredBuiltInShelves<T extends { id: string; pluginId?: string }>(shelves: T[]): T[] {
  const known = new Set(BUILTIN_SHELF_DESCRIPTORS.map((d) => d.id));
  return shelves.filter((s) => s.pluginId || known.has(s.id));
}

// Built-in shelf ids are namespaced `builtin:`; anything else is a plugin shelf
// (`<pluginId>:<shelfId>`, see `shelfKey`).
export function isBuiltInShelfId(id: string): boolean {
  return id.startsWith("builtin:");
}

// Merge a persisted shelf order with the canonical default: keep the user's
// arrangement for shelves they've ordered, drop built-in ids no longer known, and
// slot any brand-new built-in (e.g. Radio for a profile saved before it existed)
// into its default position — right after the default shelf that precedes it —
// rather than tacking it on the end.
//
// Plugin shelf ids are kept as they are, even for a plugin that isn't installed
// right now: the order is only consulted for shelves that exist, so a stale id is
// inert, and keeping it means a plugin that is disabled and re-enabled (or
// reinstalled) comes back where the user put it.
export function mergeShelfOrder(saved: string[], def: string[] = DEFAULT_SHELF_ORDER): string[] {
  const result = saved.filter(
    (id, i) => saved.indexOf(id) === i && (def.includes(id) || !isBuiltInShelfId(id)),
  );
  for (let i = 0; i < def.length; i++) {
    if (result.includes(def[i])) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const prev = result.indexOf(def[j]);
      if (prev !== -1) { at = prev + 1; break; }
    }
    result.splice(at, 0, def[i]);
  }
  return result;
}

// `order` with every id in `ids` it doesn't mention appended, in the order given.
// Turns the saved order into the full list the user is arranging: a plugin shelf
// the user has never moved isn't in the saved order yet, and appending it puts it
// exactly where `rankShelf` already ranks it — after every listed shelf.
export function completeShelfOrder(order: string[], ids: string[]): string[] {
  const seen = new Set(order);
  const extra: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    extra.push(id);
  }
  return [...order, ...extra];
}

// Move `id` to just before / after `targetId`. Returns `order` unchanged when
// either id is missing, so a stale menu action can't corrupt the arrangement.
export function moveShelf(
  order: string[],
  id: string,
  targetId: string,
  where: "before" | "after",
): string[] {
  if (id === targetId || !order.includes(id) || !order.includes(targetId)) return order;
  const rest = order.filter((x) => x !== id);
  rest.splice(rest.indexOf(targetId) + (where === "after" ? 1 : 0), 0, id);
  return rest;
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

// Map a liked-track row (from the metadata-keyed entity_likes store) to a
// track-rows item. For a LOCAL video, DROP the frozen image_url: it was
// captured at like-time and — before the async video frame was ready — often
// froze the artist image, which then masks the real frame forever. With
// image_url unset, HomeShelf resolves the live chain (video frame → album →
// artist) by exact path instead. We only drop it for local videos because
// frame extraction is local-only (extract_video_frames rejects remote tracks),
// so a non-local video's frame is never available — there the frozen image_url
// IS the right fallback, so we keep it. Non-video rows also keep it (their only
// artwork when the track isn't in the library). Scoped to these liked
// track-rows shelves, so a plugin's genuinely-explicit image_url on a video
// elsewhere (queue / now-playing) is unaffected.
function likedTrackRowItem(r: LikedEntityInfo): HomeShelfItem {
  const path = r.path ?? undefined;
  const dropImageUrl = isVideoTrack({ format: null, path }) && isLocalTrack({ path });
  return {
    track: {
      title: r.name,
      artist_name: r.artist_name ?? undefined,
      album_title: r.album_title ?? undefined,
      path,
      image_url: dropImageUrl ? undefined : (r.image_url ?? undefined),
    },
  };
}

// Resolve a cover image (album image first, artist image fallback) for a seed.
// Cache-only lookups via get_entity_image, so it stays well within the shelf budget.
async function resolveCover(
  albumTitle: string | null | undefined,
  artistName: string | null | undefined,
): Promise<string | null> {
  // A failed lookup only costs the card its cover, so it falls through to the
  // next candidate — but it is still logged, never swallowed.
  const lookup = (kind: "album" | "artist", name: string, artist: string | null) =>
    invoke<string | null>("get_entity_image", { kind, name, artistName: artist }).catch((e) => {
      console.error(`Failed to look up the ${kind} cover for "${name}":`, e);
      return null;
    });
  if (albumTitle) {
    const a = await lookup("album", albumTitle, artistName ?? null);
    if (a) return a;
  }
  if (artistName) {
    const ar = await lookup("artist", artistName, null);
    if (ar) return ar;
  }
  return null;
}

// Playlist cards for a list of mixes. Each card ships its full track list, so a
// click plays at once with the card's name as the queue banner. The cover is the
// lead track's album (artist fallback) — whatever the shuffle put first.
export async function mixCards(
  mixes: TrackMix[],
  idOf: (m: TrackMix) => string,
  nameOf: (m: TrackMix) => string,
  cover: typeof resolveCover = resolveCover,
): Promise<HomeShelfItem[]> {
  return Promise.all(mixes.map(async (m) => {
    const lead = m.tracks[0];
    const coverUrl = lead
      ? await cover(lead.album_title, lead.album_artist_name ?? lead.artist_name)
      : null;
    return {
      id: idOf(m),
      name: nameOf(m),
      subtitle: trackCountLabel(m.tracks.length),
      coverUrl: coverUrl ?? undefined,
      tracks: m.tracks.map(libraryShelfTrack),
    };
  }));
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

// Visible plugin shelves that are registered but NOT currently rendered. Unlike
// findUnattemptedShelfKeys (which trusts the persisted attemptedKeys bookkeeping),
// this keys off what's actually on screen — so a shelf that was pruned, or one
// left in a corrupted snapshot (attemptedKeys lists it while `shelves` dropped
// it), is detected and re-fetched. `renderedIds` is the id set of the current
// resolved shelves.
export function findMissingRenderedShelfKeys(
  pluginShelves: Array<{ pluginId: string; shelfId: string }>,
  visibility: Record<string, boolean>,
  renderedIds: Set<string>,
): string[] {
  return pluginShelves
    .map((p) => shelfKey(p.pluginId, p.shelfId))
    .filter((id) => isShelfVisible(id, visibility) && !renderedIds.has(id));
}

export interface ResolvedShelf {
  id: string;
  pluginId?: string;
  title: string;
  displayKind: HomeShelfDisplayKind;
  items: HomeShelfItem[];
}

// A resolver's answer. Built-ins may retitle their shelf per fetch (Discover by
// decade names the decade it drew); `title` is internal only — plugins still
// return a plain HomeShelfResult and keep their registered title.
export type ShelfFetchResult = HomeShelfResult & { title?: string };

export interface ShelfResolver {
  id: string;
  pluginId?: string;
  title: string;
  displayKind: HomeShelfDisplayKind;
  limit: number;
  fetch: (limit: number) => Promise<ShelfFetchResult>;
}

// Sort key for a shelf given the user's shelf order. Any shelf the order lists —
// built-in or plugin — ranks by its position there. An unlisted built-in (added in
// a later release, before `mergeShelfOrder` has seen it) sorts just after the
// listed shelves; an unlisted plugin shelf (one the user never moved) after that.
// Stable sorts preserve the input order among same-rank items.
function rankShelf(item: { id: string; pluginId?: string }, order: string[]): number {
  const idx = order.indexOf(item.id);
  if (idx >= 0) return idx;
  return item.pluginId ? order.length + 1 : order.length;
}

// Reorder resolved shelves to follow the user's shelf order. Pure —
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
      const result = await Promise.race<ShelfFetchResult>([
        r.fetch(r.limit),
        new Promise<ShelfFetchResult>((resolve) =>
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
        title: result.title ?? r.title,
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
  // Ids of plugins that are currently loaded & active (status === "active").
  // Used by the prune effect to tell an *uninstalled/disabled* plugin (drop its
  // hydrated shelves) from one that is still loaded but hasn't finished its
  // runtime `registerShelf` calls yet (keep them — see the prune effect). Without
  // this distinction a plugin that registers shelves late (e.g. Spotify, which
  // reads its section list from storage after activate() returns) would have its
  // cached shelves pruned the instant `pluginsLoaded` flips, then never re-added.
  activePluginIds: Set<string>;
  visibility: Record<string, boolean>;
  // User-defined shelf order (ids, built-in and plugin). Plugin shelves the user
  // never placed follow every listed shelf. Defaults to DEFAULT_SHELF_ORDER.
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
  const { isVisible, pluginShelves, invokePluginShelf, pluginsLoaded, activePluginIds, visibility, shelfOrder, restoredRef, libraryRevision } = opts;

  // Read the latest active-plugin set inside effects without adding it to their
  // dependency arrays (the Set identity changes each render).
  const activePluginIdsRef = useRef<Set<string>>(activePluginIds);
  useAssignRef(activePluginIdsRef, activePluginIds);

  const [radioStations, setRadioStations] = useState<RadioStation[]>([]);
  const [shelves, setShelves] = useState<ResolvedShelf[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const refreshGenRef = useRef(0);
  const radioStationsRef = useRef<RadioStation[]>([]);
  useAssignRef(radioStationsRef, radioStations);
  // Mirror of `shelves` so a refresh can seed itself from what's currently on
  // screen and update shelves in place (rather than collapsing the list and
  // rebuilding it one shelf at a time) — see refresh() below.
  const shelvesRef = useRef<ResolvedShelf[]>(shelves);
  useAssignRef(shelvesRef, shelves);
  const savedAtRef = useRef<number>(0);
  // Resolver ids attempted in the last completed refresh — used to detect
  // freshly-installed plugin shelves that have never been fetched.
  const attemptedKeysRef = useRef<Set<string>>(new Set());
  // Latest library revision (read via ref so refresh() doesn't depend on it), and
  // the revision the last refresh accounted for. A mismatch means a collection
  // resync landed new tracks that the shelves haven't picked up yet.
  const libRevRef = useRef(libraryRevision);
  useAssignRef(libRevRef, libraryRevision);
  const refreshedRevRef = useRef(libraryRevision);

  // Pick the radio-station seeds for the hero carousel and resolve a cover image
  // for each (album image first, artist image as fallback). Covers resolve in
  // parallel; a missing cover just renders the letter fallback in the hero.
  //
  // Shown-seed cooldown: the ids shown over the last few refreshes are passed
  // as `exclude` so a refresh cannot hand back the cards the user just saw,
  // then the ring is advanced with what was drawn (see utils/radioSeedCooldown).
  // The backend tops up from the excluded set when the library is too small, so
  // the ring never thins the carousel. A failed store read/write costs only the
  // cooldown, never the stations.
  const fetchRadioStations = useCallback(async (): Promise<RadioStation[]> => {
    try {
      let exclude: number[] = [];
      try {
        exclude = coerceSeedCooldown(await store.get<unknown>(RADIO_SEED_COOLDOWN_KEY));
      } catch (e) {
        console.error("Failed to read radio seed cooldown:", e);
      }
      const seeds = (await invoke<Track[]>("pick_radio_seeds", { count: RADIO_STATION_COUNT, exclude })) ?? [];
      if (seeds.length === 0) return [];
      store
        .set(RADIO_SEED_COOLDOWN_KEY, rememberShownSeeds(exclude, seeds.map((s) => s.id).filter((id): id is number => id != null), RADIO_STATION_COUNT))
        .catch((e) => console.error("Failed to persist radio seed cooldown:", e));
      const covers = await Promise.all(seeds.map((seed) => resolveCover(seed.album_title, seed.album_artist_name ?? seed.artist_name)));
      return seeds.map((seed, i) => ({ seed, coverUrl: covers[i] }));
    } catch (e) {
      console.error("Failed to pick radio stations:", e);
      return [];
    }
  }, []);

  const buildBuiltInResolvers = useCallback(
    (recentlyVisited: RecentlyVisitedEntry[], recentPlays: RecentPlaySession[], latestPlayVisible: boolean): ShelfResolver[] => {
      return [
        {
          id: "builtin:recently-played",
          title: "Recently played",
          displayKind: "track-rows",
          limit: 20,
          fetch: async (limit) => {
            try {
              const hist = (await invoke<HistoryEntry[]>("get_history_recent", { limit: RECENTLY_PLAYED_SCAN, resolveAlbums: true })) ?? [];
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
                    album_artist_name: h.display_album_artist ?? undefined,
                    // The library copy's own path: a local video gets its own
                    // frame (useShelfVideoFrames), and play uses that exact file.
                    path: h.display_path ?? undefined,
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
              // At least two plays in the window: with one each, the shelf was
              // just a reordered "Recently played".
              const tracks = (await invoke<HistoryMostPlayed[]>("get_history_most_played_since", { sinceTs, limit, minPlays: 2 })) ?? [];
              if (tracks.length === 0) return { status: "empty" };
              return {
                status: "ok",
                items: tracks.map(t => ({
                  track: {
                    title: t.display_title,
                    artist_name: t.display_artist ?? undefined,
                    // Library-resolved album (history stores none) → album cover
                    // via the shared chain, artist-image fallback when absent.
                    album_title: t.display_album ?? undefined,
                    album_artist_name: t.display_album_artist ?? undefined,
                    // Library copy's path → video frame, as on Recently played.
                    path: t.display_path ?? undefined,
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
              // limit is passed through to SQL — this used to fetch the whole
              // album table (~300 KB of JSON on a large library) to show 20 cards.
              const albums = (await invoke<Album[]>("get_albums", { artistId: null, sort: "added_desc", limit })) ?? [];
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
              return { status: "ok", items: rows.map(likedTrackRowItem) };
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
                // A failed lookup still shows the card (it navigates by name).
                const album = await invoke<Album | null>("find_album_by_name", { title: r.name, artistName: r.artist_name ?? null }).catch((e) => {
                  console.error(`Failed to resolve liked album "${r.name}":`, e);
                  return null;
                });
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
                const artist = await invoke<Artist | null>("find_artist_by_name", { name: r.name }).catch((e) => {
                  console.error(`Failed to resolve liked artist "${r.name}":`, e);
                  return null;
                });
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
              return { status: "ok", items: rows.map(likedTrackRowItem) };
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
              // Shuffled + limited in SQL: the whole liked list used to come
              // across IPC only to show its alphabetical first 20.
              const albums = (await invoke<Album[]>("get_albums", { artistId: null, likedOnly: true, sort: "random", limit })) ?? [];
              return {
                status: "ok",
                items: albums.map(a => ({
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
              const artists = (await invoke<Artist[]>("get_artists", { likedOnly: true, sort: "random", limit })) ?? [];
              return {
                status: "ok",
                items: artists.map(a => ({
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
          // Playlists, not single tracks: the backend shuffles the forgotten
          // pool (weighted by plays) and groups it by tag, plus one catch-all.
          displayKind: "playlist-cards",
          limit: FORGOTTEN_MIX_COUNT,
          fetch: async (limit) => {
            try {
              const mixes = (await invoke<TrackMix[]>("pick_forgotten_mixes", { maxMixes: limit, mixSize: MIX_SIZE })) ?? [];
              if (mixes.length === 0) return { status: "empty" };
              const items = await mixCards(
                mixes,
                (m) => `forgotten:${m.tag ?? "*"}`,
                (m) => forgottenMixName(m.tag),
              );
              return { status: "ok", items };
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
                items: tracks.map(t => ({ track: libraryShelfTrack(t) })),
              };
            } catch (e) {
              return { status: "error", message: String(e) };
            }
          },
        },
        {
          id: "builtin:discover-by-decade",
          title: "Discover by decade",
          // The Playlists view's auto decade mixes, oldest first — one "1990s"
          // mix across the app rather than a second, different one here. They
          // regenerate on their own 24h cycle (App.tsx, `ensure_auto_playlists`)
          // and only exist for decades with enough tracks, so a stray reissue's
          // decade never gets a one-card shelf. Each card ships its full list,
          // and Latest play snapshots it, so a replay is the mix that was heard.
          displayKind: "playlist-cards",
          limit: 10,
          fetch: async (limit) => {
            try {
              const rows = (await invoke<DecadePlaylistRow[]>("get_playlists")) ?? [];
              const decades = decadePlaylists(rows).slice(0, limit);
              if (decades.length === 0) return { status: "empty" };
              const items = await Promise.all(decades.map(async (p): Promise<HomeShelfItem | null> => {
                const rows = (await invoke<PlaylistTrackRow[]>("get_playlist_tracks", { playlistId: p.id })) ?? [];
                if (rows.length === 0) return null;
                const lead = rows[0];
                const coverUrl = p.image_path ?? (await resolveCover(lead.album_name, lead.artist_name));
                return {
                  id: `playlist:${p.id}`,
                  name: p.name,
                  subtitle: trackCountLabel(rows.length),
                  coverUrl: coverUrl ?? undefined,
                  tracks: rows.map(playlistShelfTrack),
                };
              }));
              const cards = items.filter((it): it is HomeShelfItem => it !== null);
              return cards.length > 0 ? { status: "ok", items: cards } : { status: "empty" };
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
              // Every recorded visit (the ring holds 20), looked up in parallel,
              // so dropping the ones Latest play already shows can still fill
              // `limit` cards.
              const sorted = [...recentlyVisited].sort((a, b) => b.ts - a.ts);
              const resolved = await Promise.all(sorted.map(async (v) => {
                if (v.kind === "album") {
                  const a = await invoke<Album | null>("get_album_by_id", { albumId: v.id });
                  return a ? { libraryId: a.id, name: a.title, artistName: a.artist_name ?? undefined, entityKind: "album" as const } : null;
                }
                const ar = await invoke<Artist | null>("get_artist_by_id", { artistId: v.id });
                return ar ? { libraryId: ar.id, name: ar.name, entityKind: "artist" as const } : null;
              }));
              const shownSessions = latestPlayVisible
                ? [...recentPlays].sort((a, b) => b.ts - a.ts).slice(0, LATEST_PLAY_LIMIT)
                : [];
              const items: HomeShelfItem[] = resolved
                .filter((it): it is NonNullable<typeof it> => it !== null)
                .filter((it) => !visitAlreadyInLatestPlay(it, shownSessions))
                .slice(0, limit);
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
          limit: LATEST_PLAY_LIMIT,
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

      const builtIns = buildBuiltInResolvers(recentlyVisited, recentPlays, isShelfVisible(LATEST_PLAY_SHELF_ID, visibility));
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
        // Apply the user's shelf order; unplaced plugin shelves follow it.
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
          const result = await Promise.race<ShelfFetchResult>([
            r.fetch(r.limit),
            new Promise<ShelfFetchResult>((resolve) =>
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
            title: result.title ?? r.title,
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
        if (snap?.shelves?.length) setShelves(dropRetiredBuiltInShelves(snap.shelves));
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
  // uninstalled/disabled since the snapshot was saved). Built-in shelves (no
  // pluginId) are never pruned. Gated on pluginsLoaded so we don't drop valid
  // plugin shelves during the async load window — an empty pluginShelves there
  // means "not loaded yet", not "gone". This complements the 24h refresh gate:
  // without it, a removed plugin's shelves would linger from cache until refresh.
  //
  // Keyed on the PLUGIN being active, NOT on the specific shelf id being present
  // in `pluginShelves`: a loaded plugin can register its shelves late (Spotify
  // reads its section list from storage after activate() returns), so a shelf id
  // absent right when `pluginsLoaded` flips is "not registered yet", not "gone".
  // Dropping it here would strand the cached shelf (the refresh gate keys off the
  // persisted attemptedKeys and won't re-fetch it). A shelf whose plugin stays
  // active but which was genuinely unregistered self-heals on the next refresh's
  // final pass (only resolvers that ran OK survive).
  useEffect(() => {
    if (!pluginsLoaded) return;
    setShelves((prev) => {
      const next = prev.filter((s) => !s.pluginId || activePluginIdsRef.current.has(s.pluginId));
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
    // A registered, visible plugin shelf that isn't currently on screen needs a
    // fetch even if attemptedKeys says we've "seen" it — e.g. a shelf that was
    // pruned (or a snapshot left corrupted by the old prune, which persisted the
    // key in attemptedKeys while dropping the shelf) then re-registered by a
    // late-loading plugin. Rendered `shelves` is the ground truth for "have it".
    const renderedIds = new Set(shelvesRef.current.map((s) => s.id));
    const missingRendered = findMissingRenderedShelfKeys(pluginShelves, visibility, renderedIds).length > 0;
    if (savedAtRef.current === 0 || age >= STALE_MS || hasNewShelves || missingRendered) refresh();
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

  // `hydrated` is exposed so Home can tell "no shelves because the snapshot
  // hasn't been read yet" from "no shelves because there genuinely are none" —
  // the latter is what its empty state renders.
  return { radioStations, shelves, refresh, isLoading, hydrated };
}
