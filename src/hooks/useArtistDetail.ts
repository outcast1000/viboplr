import { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Artist, Album, Track, SortField, SortDir } from "../types";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { stripAccents } from "../utils";

const normalizeTitle = (s: string) => stripAccents(s.toLowerCase().replace(/\([^)]*\)/g, "").trim()).replace(/[^\p{L}\p{N}]/gu, "");

type BackendTypeRow = [string, string, string, number, number, Array<[string, number]>];

export interface UseArtistDetailReturn {
  artist: Artist | null;
  tracks: Track[];
  sortedTracks: Track[];
  albums: Album[];
  isLibrary: boolean;
  sortField: SortField | null;
  handleSort: (field: SortField) => void;
  sortIndicator: (field: SortField) => string;
  trackPopularity: Record<number, number>;
  handleToggleArtistLike: () => void;
  handleToggleArtistDislike: () => void;
  reload: () => void;
}

export function useArtistDetail(
  name: string,
  invokeInfoFetch?: (pluginId: string, infoTypeId: string, entity: InfoEntity) => Promise<InfoFetchResult>,
): UseArtistDetailReturn {
  const [artist, setArtist] = useState<Artist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [shuffleKey, setShuffleKey] = useState(0);
  const [loadKey, setLoadKey] = useState(0);
  const [trackPopularity, setTrackPopularity] = useState<Record<number, number>>({});

  // Resolve artist and fetch data
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const found = await invoke<Artist | null>("find_artist_by_name", { name });
        if (cancelled) return;
        setArtist(found);

        if (found) {
          const [fetchedTracks, fetchedAlbums] = await Promise.all([
            invoke<Track[]>("get_tracks_by_artist", { artistId: found.id }),
            invoke<Album[]>("get_albums", { artistId: found.id }),
          ]);
          if (cancelled) return;
          setTracks(fetchedTracks);
          setAlbums(fetchedAlbums.sort((a, b) => (b.year ?? 0) - (a.year ?? 0)));
        } else {
          setTracks([]);
          setAlbums([]);
        }
      } catch (e) {
        console.error("Failed to load artist detail:", e);
        if (!cancelled) {
          setArtist(null);
          setTracks([]);
          setAlbums([]);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [name, loadKey]);

  // Fetch track popularity from ranked_list info types
  useEffect(() => {
    setTrackPopularity({});
    if (!artist || !invokeInfoFetch) return;

    let cancelled = false;
    (async () => {
      try {
        const types = await invoke<BackendTypeRow[]>("info_get_types_for_entity", { entity: "artist" });
        const rankedType = types.find(([, , displayKind]) => displayKind === "ranked_list");
        if (!rankedType || cancelled) return;

        const [typeId, , , , , providers] = rankedType;
        const entity: InfoEntity = { kind: "artist", name: artist.name, id: artist.id };

        for (const [pluginId] of providers) {
          if (cancelled) return;
          try {
            const result = await invokeInfoFetch(pluginId, typeId, entity);
            if (cancelled || result.status !== "ok") continue;
            const items = (result.value as Record<string, unknown>)?.items as Array<{ name: string; value: number }> | undefined;
            if (!items) continue;
            const popMap: Record<number, number> = {};
            for (const item of items) {
              const norm = normalizeTitle(item.name);
              const match = tracks.find(t => normalizeTitle(t.title) === norm);
              if (match && match.id != null && item.value > 0) popMap[match.id] = item.value;
            }
            if (!cancelled) setTrackPopularity(popMap);
            return;
          } catch { continue; }
        }
      } catch (e) {
        console.error("Failed to fetch artist track popularity:", e);
      }
    })();

    return () => { cancelled = true; };
  }, [artist, tracks, invokeInfoFetch]);

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
      const shuffled = [...tracks];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, sortField, sortDir, shuffleKey, trackPopularity]);

  const handleToggleArtistLike = useCallback(() => {
    if (!artist) return;
    const newLiked = artist.liked === 1 ? 0 : 1;
    invoke("toggle_liked", { kind: "artist", id: artist.id, liked: newLiked })
      .then(() => setArtist(prev => prev ? { ...prev, liked: newLiked } : null))
      .catch((e) => console.error("Failed to toggle artist like:", e));
  }, [artist]);

  const handleToggleArtistDislike = useCallback(() => {
    if (!artist) return;
    const newLiked = artist.liked === -1 ? 0 : -1;
    invoke("toggle_liked", { kind: "artist", id: artist.id, liked: newLiked })
      .then(() => setArtist(prev => prev ? { ...prev, liked: newLiked } : null))
      .catch((e) => console.error("Failed to toggle artist dislike:", e));
  }, [artist]);

  const reload = useCallback(() => {
    setLoadKey(k => k + 1);
  }, []);

  return {
    artist,
    tracks,
    sortedTracks,
    albums,
    isLibrary: artist !== null,
    sortField,
    handleSort,
    sortIndicator,
    trackPopularity,
    handleToggleArtistLike,
    handleToggleArtistDislike,
    reload,
  };
}
