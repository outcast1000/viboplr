import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Artist, Album, Tag, Track, QueueTrack, SortField, SortDir } from "../types";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { stripAccents } from "../utils";
import { buildExternalQueueTrack } from "../utils/externalTrack";
import { nextTriState } from "../likeKeys";
import { subscribeTrackEvents } from "../trackEvents";
import { useAssignRef } from "./useLatestRef";

const normalizeTitle = (s: string) => stripAccents(s.toLowerCase().replace(/\([^)]*\)/g, "").trim()).replace(/[^\p{L}\p{N}]/gu, "");

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
  /** Album pages only, when the album isn't in the library: its tracklist from
   *  the album `ranked_list` provider, metadata-only (the stream resolvers find
   *  each source at play time, a library copy first). */
  externalTracks: QueueTrack[];
  /** The provider's value per external track (Last.fm listeners), parallel to
   *  `externalTracks`; 0 when it reported none. */
  externalValues: number[];
  externalStatus: "idle" | "loading" | "ok" | "none";
  sortField: SortField | null;
  handleSort: (field: SortField) => void;
  sortIndicator: (field: SortField) => string;
  trackPopularity: Record<number, number>;
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
  const [external, setExternal] = useState<{
    key: string; status: "ok" | "none"; tracks: QueueTrack[]; values: number[];
  } | null>(null);
  const [entity, setEntity] = useState<Artist | Album | Tag | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [shuffleKey, setShuffleKey] = useState(0);
  const [loadKey, setLoadKey] = useState(0);
  const [trackPopularity, setTrackPopularity] = useState<Record<number, number>>({});

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

  // Stable signature of the track *set* (ids only). Patches that mutate a field
  // like `liked` produce a new `tracks` array but the same id set, so this key
  // is unchanged — keeping the popularity effect below from re-running (and
  // blanking the popularity bars) on every like/dislike.
  const trackIdsKey = useMemo(() => tracks.map(t => t.id ?? "x").join(","), [tracks]);

  // Read latest tracks inside the popularity effect without making the array
  // identity a dependency (so field-only patches don't re-run it).
  const tracksRef = useRef(tracks);
  useAssignRef(tracksRef, tracks);

  // The entity's ranked_list info type (artist and album only). One fetch, two
  // uses: for a library entity it supplies the track popularity bars; for an
  // album that isn't in the library it *is* the tracklist — the provider lists
  // the album's tracks in album order (Last.fm `album.getInfo`).
  const wantsExternalTracklist = loaded && !entity && kind === "album";
  useEffect(() => {
    setTrackPopularity({});
    if (kind === "tag" || !(entity || wantsExternalTracklist)) return;
    const key = `${kind}|${name}|${artistName ?? ""}`;
    const settleExternal = (tracks: QueueTrack[], values: number[] = []) => {
      if (!entity) setExternal({ key, status: tracks.length > 0 ? "ok" : "none", tracks, values });
    };
    // No info system wired (never in the app) — externalStatus reports "none".
    if (!invokeInfoFetch) return;

    let cancelled = false;
    (async () => {
      try {
        const types = await invoke<BackendTypeRow[]>("info_get_types_for_entity", { entity: kind });
        if (cancelled) return;
        const rankedType = types.find(([, , displayKind]) => displayKind === "ranked_list");
        if (!rankedType) { settleExternal([]); return; }

        const [typeId, , , , , providers] = rankedType;
        const infoEntity: InfoEntity = !entity
          ? { kind: "album", name, id: 0, artistName }
          : kind === "artist"
            ? { kind: "artist", name: (entity as Artist).name, id: entity.id }
            : { kind: "album", name: (entity as Album).title, id: entity.id, artistName: (entity as Album).artist_name ?? undefined };

        for (const [pluginId] of providers) {
          if (cancelled) return;
          try {
            const result = await invokeInfoFetch(pluginId, typeId, infoEntity);
            if (cancelled || result.status !== "ok") continue;
            const items = (result.value as Record<string, unknown>)?.items as Array<{ name: string; subtitle?: string; value: number }> | undefined;
            if (!items) continue;
            if (!entity) {
              settleExternal(items.map(item => ({
                ...buildExternalQueueTrack(item.name, item.subtitle ?? artistName),
                album_title: name,
                album_artist_name: artistName ?? null,
              })), items.map(item => item.value > 0 ? item.value : 0));
              return;
            }
            const popMap: Record<number, number> = {};
            for (const item of items) {
              const norm = normalizeTitle(item.name);
              const match = tracksRef.current.find(t => normalizeTitle(t.title) === norm);
              if (match && match.id != null && item.value > 0) popMap[match.id] = item.value;
            }
            setTrackPopularity(popMap);
            return;
          } catch (e) {
            // Fall through to the next provider, but don't hide why this one lost.
            console.error(`Ranked-list provider "${pluginId}" failed for ${kind}:`, e);
            continue;
          }
        }
        if (!cancelled) settleExternal([]);
      } catch (e) {
        console.error(`Failed to fetch ${kind} ranked list:`, e);
        if (!cancelled) settleExternal([]);
      }
    })();

    return () => { cancelled = true; };
    // trackIdsKey (not `tracks`) so field-only patches like `liked` don't refetch.
  }, [entity, wantsExternalTracklist, trackIdsKey, invokeInfoFetch, kind, name, artistName]);

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
    externalTracks: !entity && external?.key === detailKey ? external.tracks : EMPTY_EXTERNAL,
    externalValues: !entity && external?.key === detailKey ? external.values : EMPTY_VALUES,
    externalStatus: !wantsExternalTracklist ? "idle"
      : !invokeInfoFetch ? "none"
      : external?.key === detailKey ? external.status : "loading",
    sortField,
    handleSort,
    sortIndicator,
    trackPopularity,
    handleToggleLike,
    handleToggleDislike,
    handleToggleAlbumLike,
    handleToggleAlbumDislike,
    reload,
  };
}
