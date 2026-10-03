import { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Artist, Album, Tag, Track, QueueTrack, SortField, SortDir } from "../types";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { normalizeTrackTitle } from "../utils/missingTracks";
import { buildExternalQueueTrack } from "../utils/externalTrack";
import { nextTriState } from "../likeKeys";
import { subscribeTrackEvents } from "../trackEvents";


/**
 * Deterministic PRNG (mulberry32), so the "random" track sort is a pure function
 * of its seed.
 *
 * The shuffle used to call `Math.random()` directly inside the `sortedTracks`
 * `useMemo`. A memo body runs **during render**, so an impure one isn't stable:
 * React recomputes the memo whenever any dependency changes — a fresh `tracks`
 * identity from a track event, a popularity refresh, a `sortDir` flip — and each
 * recompute silently dealt a brand-new order, while StrictMode's double render
 * committed a different order than the one it first computed. The list reshuffled
 * under the user for reasons they didn't cause.
 *
 * `shuffleKey` (bumped only by `handleSort("random")`) was already the intended
 * "re-roll now" signal and was already a memo dependency; seeding from it is what
 * makes that intent actually hold. Same visible behaviour on a click, stable
 * between clicks. Found by `react-hooks/purity`.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EMPTY_EXTERNAL: QueueTrack[] = [];
const EMPTY_VALUES: number[] = [];

/** One row of a ranked_list info value. */
interface RankedItem { name: string; subtitle?: string; value: number }

type BackendTypeRow =[string, string, string, number, number, Array<[string, number]>];

interface EntityDetailConfig {
  kind: "artist" | "album" | "tag";
  name: string;
  artistName?: string;
  invokeInfoFetch?: (pluginId: string, infoTypeId: string, entity: InfoEntity, onFetchUrl?: (url: string) => void) => Promise<InfoFetchResult>;
  onEntityLike?: (kind: "artist" | "album" | "tag", id: number) => void;
  onEntityDislike?: (kind: "artist" | "album" | "tag", id: number) => void;
  /** Like/dislike for an entity that isn't in the library (no id). Resolves
   *  whether the write landed, so the optimistic state can be reverted. */
  onEntityLikeByName?: (kind: "artist" | "album" | "tag", name: string, artistName: string | undefined, likeState: number) => Promise<boolean>;
  /** External refetch trigger — bumping this re-runs the load effect (e.g. after
   *  a bulk edit changes the track set). */
  reloadSignal?: number;
}

export interface EntityDetailReturn {
  entity: Artist | Album | Tag | null;
  tracks: Track[];
  sortedTracks: Track[];
  albums: Album[];
  isLibrary: boolean;
  /** The library lookup for the current name has answered (found or not). */
  loaded: boolean;
  /** Like state shown in the hero: the row's own, or — for an entity that
   *  isn't in the library — the durable name-keyed one. */
  liked: number;
  /** Album and artist pages: the entity's `ranked_list` as metadata-only
   *  queue tracks (the stream resolvers find each source at play time, a
   *  library copy first) — an album's tracklist in album order, an artist's
   *  Top Songs in rank order. Empty until it arrives. */
  rankedTracks: QueueTrack[];
  /** The provider's value per row (Last.fm listeners), parallel to
   *  `rankedTracks`; 0 when it reported none. */
  rankedValues: number[];
  /** "idle" on tag pages and before the library lookup answers. */
  rankedStatus: "idle" | "loading" | "ok" | "none";
  /** The ranked_list info type the list came from — a page that merges the
   *  list into its own hides that tab, since it already shows the same rows. */
  rankedTypeId: string | null;
  sortField: SortField | null;
  sortDir: SortDir;
  handleSort: (field: SortField) => void;
  sortIndicator: (field: SortField) => string;
  trackPopularity: Record<number, number>;
  /** The track list's local filter text (see utils/detailTrackFilter). Belongs
   *  to the page it was typed on — it reads "" again on the next entity. */
  filterQuery: string;
  setFilterQuery: (query: string) => void;
  handleToggleLike: () => void;
  handleToggleDislike: () => void;
  handleToggleAlbumLike: (albumId: number) => void;
  handleToggleAlbumDislike: (albumId: number) => void;
  reload: () => void;
}

export function useEntityDetail({ kind, name, artistName, invokeInfoFetch, onEntityLike, onEntityDislike, onEntityLikeByName, reloadSignal }: EntityDetailConfig): EntityDetailReturn {
  // Which page the state below describes. Everything loaded asynchronously is
  // stamped with the key it was loaded for, so a late answer for the previous
  // page never shows on the next one.
  const detailKey = `${kind}|${name}|${artistName ?? ""}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loaded = loadedKey === detailKey;
  const [nameLike, setNameLike] = useState<{ key: string; liked: number } | null>(null);
  const [ranked, setRanked] = useState<{
    key: string; status: "loading" | "ok" | "none"; items: RankedItem[]; typeId: string | null;
  } | null>(null);
  const [entity, setEntity] = useState<Artist | Album | Tag | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [shuffleKey, setShuffleKey] = useState(0);
  const [loadKey, setLoadKey] = useState(0);
  // Stamped with the page key like the async state above, so navigating to
  // another entity starts unfiltered without an effect to clear it.
  const [filter, setFilter] = useState<{ key: string; query: string } | null>(null);
  const filterQuery = filter?.key === detailKey ? filter.query : "";
  const setFilterQuery = useCallback((query: string) => setFilter({ key: detailKey, query }), [detailKey]);

  useEffect(() => {
    let cancelled = false;
    const key = `${kind}|${name}|${artistName ?? ""}`;

    (async () => {
      try {
        let found: Artist | Album | Tag | null = null;

        if (kind === "artist") {
          found = await invoke<Artist | null>("find_artist_by_name", { name });
        } else if (kind === "album") {
          found = await invoke<Album | null>("find_album_by_name", { title: name, artistName: artistName ?? null });
        } else {
          found = await invoke<Tag | null>("find_tag_by_name", { name });
        }

        if (cancelled) return;
        setEntity(found);

        if (found) {
          if (kind === "artist") {
            const [fetchedTracks, fetchedAlbums] = await Promise.all([
              invoke<Track[]>("get_tracks_by_artist", { artistId: found.id }),
              invoke<Album[]>("get_albums", { artistId: found.id }),
            ]);
            if (cancelled) return;
            setTracks(fetchedTracks);
            setAlbums(fetchedAlbums.sort((a, b) => (b.year ?? 0) - (a.year ?? 0)));
          } else if (kind === "album") {
            const fetchedTracks = await invoke<Track[]>("get_tracks", { opts: { albumId: found.id } });
            if (cancelled) return;
            setTracks(fetchedTracks);
            setAlbums([]);
          } else {
            const fetchedTracks = await invoke<Track[]>("get_tracks_by_tag", { tagId: found.id });
            if (cancelled) return;
            setTracks(fetchedTracks);
            setAlbums([]);
          }
        } else {
          setTracks([]);
          setAlbums([]);
          // Not in the library: the like still exists by name.
          invoke<number>("get_entity_like_state", { kind, name, artistName: artistName ?? null })
            .then(liked => { if (!cancelled) setNameLike({ key, liked }); })
            .catch(e => console.error(`Failed to load ${kind} like state:`, e));
        }
        if (!cancelled) setLoadedKey(key);
      } catch (e) {
        console.error(`Failed to load ${kind} detail:`, e);
        if (!cancelled) {
          setEntity(null);
          setTracks([]);
          setAlbums([]);
          setLoadedKey(key);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [kind, name, artistName, loadKey, reloadSignal]);

  useEffect(() => {
    return subscribeTrackEvents(event => {
      if (event.kind === "patch") {
        setTracks(prev => prev.map(t => t.id === event.trackId ? { ...t, ...event.patch } : t));
      } else {
        const removed = new Set(event.trackIds);
        setTracks(prev => prev.filter(t => t.id == null || !removed.has(t.id)));
      }
    });
  }, []);

  // The entity's ranked_list info type (artist and album only), fetched once
  // per page. Everything else is derived from the raw items below, so a like
  // toggle (a new `entity` / `tracks` identity) neither refetches nor blanks
  // anything — the effect keys on the entity's identity fields, not the object.
  const entityId = entity?.id ?? null;
  const entityName = entity ? (kind === "artist" ? (entity as Artist).name : kind === "album" ? (entity as Album).title : (entity as Tag).name) : null;
  const entityArtist = entity && kind === "album" ? (entity as Album).artist_name ?? undefined : undefined;
  useEffect(() => {
    if (!loaded || kind === "tag") return;
    const key = `${kind}|${name}|${artistName ?? ""}`;
    const settle = (items: RankedItem[], typeId: string | null) =>
      setRanked({ key, status: items.length > 0 ? "ok" : "none", items, typeId });
    // No info system wired (never in the app) — rankedStatus reports "none".
    if (!invokeInfoFetch) return;

    let cancelled = false;
    (async () => {
      try {
        const types = await invoke<BackendTypeRow[]>("info_get_types_for_entity", { entity: kind });
        if (cancelled) return;
        const rankedType = types.find(([, , displayKind]) => displayKind === "ranked_list");
        if (!rankedType) { settle([], null); return; }

        const [typeId, , , , , providers] = rankedType;
        // Publish the type id before the (slow) provider fetch: the page hides
        // that tab by id, and a late `exclude` change reloads every section.
        setRanked({ key, status: "loading", items: [], typeId });
        const infoEntity: InfoEntity = entityId == null
          ? { kind, name, id: 0, artistName: kind === "album" ? artistName : undefined }
          : kind === "artist"
            ? { kind: "artist", name: entityName!, id: entityId }
            : { kind: "album", name: entityName!, id: entityId, artistName: entityArtist };

        for (const [pluginId] of providers) {
          if (cancelled) return;
          try {
            const result = await invokeInfoFetch(pluginId, typeId, infoEntity);
            if (cancelled || result.status !== "ok") continue;
            const items = (result.value as Record<string, unknown>)?.items as RankedItem[] | undefined;
            if (!items) continue;
            settle(items, typeId);
            return;
          } catch (e) {
            // Fall through to the next provider, but don't hide why this one lost.
            console.error(`Ranked-list provider "${pluginId}" failed for ${kind}:`, e);
            continue;
          }
        }
        if (!cancelled) settle([], typeId);
      } catch (e) {
        console.error(`Failed to fetch ${kind} ranked list:`, e);
        if (!cancelled) settle([], null);
      }
    })();

    return () => { cancelled = true; };
  }, [loaded, entityId, entityName, entityArtist, invokeInfoFetch, kind, name, artistName]);

  const rankedItems = ranked?.key === detailKey ? ranked.items : null;

  // Popularity bars: each library row's provider value, matched by title.
  const trackPopularity = useMemo(() => {
    const popMap: Record<number, number> = {};
    if (!rankedItems || !entity) return popMap;
    for (const item of rankedItems) {
      const norm = normalizeTrackTitle(item.name);
      const match = tracks.find(t => normalizeTrackTitle(t.title) === norm);
      if (match && match.id != null && item.value > 0) popMap[match.id] = item.value;
    }
    return popMap;
  }, [rankedItems, entity, tracks]);

  // The ranked list as metadata-only queue tracks. A library page merges the
  // ones the user lacks into its own track list; an album that isn't in the
  // library shows it as its tracklist. Album rows are filed under the album;
  // an artist's Top Songs carry no album.
  const rankedTracks = useMemo(() => {
    if (kind === "tag" || !rankedItems) return EMPTY_EXTERNAL;
    if (kind === "artist") {
      return rankedItems.map(item => buildExternalQueueTrack(item.name, item.subtitle ?? entityName ?? name));
    }
    return rankedItems.map(item => ({
      ...buildExternalQueueTrack(item.name, item.subtitle ?? artistName),
      album_title: entityName ?? name,
      album_artist_name: entityArtist ?? artistName ?? null,
    }));
  }, [kind, rankedItems, name, artistName, entityName, entityArtist]);
  const rankedValues = useMemo(
    () => kind !== "tag" && rankedItems ? rankedItems.map(item => item.value > 0 ? item.value : 0) : EMPTY_VALUES,
    [kind, rankedItems],
  );

  const handleSort = useCallback((field: SortField) => {
    if (field === "random") {
      if (sortField === "random") {
        setSortField(null);
        setSortDir("asc");
      } else {
        setSortField("random");
        setSortDir("asc");
      }
      setShuffleKey(k => k + 1);
      return;
    }
    const descFirst: SortField[] = ["duration", "year", "added", "modified", "size", "popularity"];
    const initial = descFirst.includes(field) ? "desc" : "asc";
    const flipped = initial === "asc" ? "desc" : "asc";
    if (sortField === field) {
      if (sortDir === initial) {
        setSortDir(flipped);
      } else {
        setSortField(null);
        setSortDir("asc");
      }
    } else {
      setSortField(field);
      setSortDir(initial);
    }
  }, [sortField, sortDir]);

  const sortIndicator = useCallback((field: SortField): string => {
    if (sortField !== field) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }, [sortField, sortDir]);

  const sortedTracks = useMemo(() => {
    if (!sortField) return tracks;
    if (sortField === "random") {
      // Seeded from `shuffleKey`, never `Math.random()`. See seededRandom below.
      const rand = seededRandom(shuffleKey);
      const shuffled = [...tracks];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    }
    const sorted = [...tracks];
    const dir = sortDir === "asc" ? 1 : -1;
    sorted.sort((a, b) => {
      switch (sortField) {
        case "num": return ((a.track_number ?? 0) - (b.track_number ?? 0)) * dir;
        case "title": return (a.title.localeCompare(b.title)) * dir;
        case "artist": return ((a.artist_name ?? "").localeCompare(b.artist_name ?? "")) * dir;
        case "album": return ((a.album_title ?? "").localeCompare(b.album_title ?? "")) * dir;
        case "duration": return ((a.duration_secs ?? 0) - (b.duration_secs ?? 0)) * dir;
        case "path": return ((a.path ?? "").localeCompare(b.path ?? "")) * dir;
        case "year": return ((a.year ?? 0) - (b.year ?? 0)) * dir;
        case "quality": {
          const bitrateA = (a.duration_secs && a.file_size) ? a.file_size * 8 / a.duration_secs / 1000 : 0;
          const bitrateB = (b.duration_secs && b.file_size) ? b.file_size * 8 / b.duration_secs / 1000 : 0;
          return (bitrateA - bitrateB) * dir;
        }
        case "size": return ((a.file_size ?? 0) - (b.file_size ?? 0)) * dir;
        case "collection": return ((a.collection_name ?? "").localeCompare(b.collection_name ?? "")) * dir;
        case "added": return ((a.added_at ?? 0) - (b.added_at ?? 0)) * dir;
        case "modified": return ((a.modified_at ?? 0) - (b.modified_at ?? 0)) * dir;
        case "popularity": return ((trackPopularity[(a.id ?? 0)] ?? 0) - (trackPopularity[(b.id ?? 0)] ?? 0)) * dir;
        default: return 0;
      }
    });
    return sorted;
    // `shuffleKey` is a real dependency now that the shuffle is seeded from it.
    // It used to be listed but never read — the disable comment that silenced
    // that went away with the Math.random() it was covering for.
  }, [tracks, sortField, sortDir, shuffleKey, trackPopularity]);

  const liked = entity ? entity.liked : nameLike?.key === detailKey ? nameLike.liked : 0;

  // An entity that isn't in the library has no id to toggle, but its like is
  // name-keyed: written by name, shown optimistically, reverted if it fails.
  const rateByName = useCallback(async (action: "like" | "dislike") => {
    if (!onEntityLikeByName || !loaded) return;
    const prev = liked;
    const next = nextTriState(prev, action);
    setNameLike({ key: detailKey, liked: next });
    if (!(await onEntityLikeByName(kind, name, artistName, next))) {
      setNameLike(cur => cur?.key === detailKey ? { key: detailKey, liked: prev } : cur);
    }
  }, [onEntityLikeByName, loaded, liked, detailKey, kind, name, artistName]);

  const handleToggleLike = useCallback(() => {
    if (!entity) { void rateByName("like"); return; }
    if (!onEntityLike) return;
    onEntityLike(kind, entity.id);
    setEntity(prev => prev ? { ...prev, liked: prev.liked === 1 ? 0 : 1 } : null);
  }, [entity, kind, onEntityLike, rateByName]);

  const handleToggleDislike = useCallback(() => {
    if (!entity) { void rateByName("dislike"); return; }
    if (!onEntityDislike) return;
    onEntityDislike(kind, entity.id);
    setEntity(prev => prev ? { ...prev, liked: prev.liked === -1 ? 0 : -1 } : null);
  }, [entity, kind, onEntityDislike, rateByName]);

  // Albums shown on the artist-detail page live in this hook's local state
  // (loaded via get_albums), separate from library.albums — so they need their
  // own optimistic patch to reflect a like/dislike immediately.
  const handleToggleAlbumLike = useCallback((albumId: number) => {
    if (!onEntityLike) return;
    onEntityLike("album", albumId);
    setAlbums(prev => prev.map(a => a.id === albumId ? { ...a, liked: a.liked === 1 ? 0 : 1 } : a));
  }, [onEntityLike]);

  const handleToggleAlbumDislike = useCallback((albumId: number) => {
    if (!onEntityDislike) return;
    onEntityDislike("album", albumId);
    setAlbums(prev => prev.map(a => a.id === albumId ? { ...a, liked: a.liked === -1 ? 0 : -1 } : a));
  }, [onEntityDislike]);

  const reload = useCallback(() => {
    setLoadKey(k => k + 1);
  }, []);

  return {
    entity,
    tracks,
    sortedTracks,
    albums,
    isLibrary: entity !== null,
    loaded,
    liked,
    rankedTracks,
    rankedValues,
    rankedStatus: kind === "tag" || !loaded ? "idle"
      : !invokeInfoFetch ? "none"
      : ranked?.key === detailKey ? ranked.status : "loading",
    rankedTypeId: ranked?.key === detailKey ? ranked.typeId : null,
    sortField,
    sortDir,
    handleSort,
    sortIndicator,
    trackPopularity,
    filterQuery,
    setFilterQuery,
    handleToggleLike,
    handleToggleDislike,
    handleToggleAlbumLike,
    handleToggleAlbumDislike,
    reload,
  };
}
