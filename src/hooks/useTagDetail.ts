import { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Tag, Track, SortField, SortDir } from "../types";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";

export interface UseTagDetailReturn {
  tag: Tag | null;
  tracks: Track[];
  sortedTracks: Track[];
  isLibrary: boolean;
  sortField: SortField | null;
  handleSort: (field: SortField) => void;
  sortIndicator: (field: SortField) => string;
  handleToggleTagLike: () => void;
  handleToggleTagDislike: () => void;
  reload: () => void;
}

export function useTagDetail(
  name: string,
  _invokeInfoFetch?: (pluginId: string, infoTypeId: string, entity: InfoEntity) => Promise<InfoFetchResult>,
): UseTagDetailReturn {
  const [tag, setTag] = useState<Tag | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [shuffleKey, setShuffleKey] = useState(0);
  const [loadKey, setLoadKey] = useState(0);

  // Resolve tag and fetch tracks
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const found = await invoke<Tag | null>("find_tag_by_name", { name });
        if (cancelled) return;
        setTag(found);

        if (found) {
          const fetchedTracks = await invoke<Track[]>("get_tracks_by_tag", { tagId: found.id });
          if (cancelled) return;
          setTracks(fetchedTracks);
        } else {
          setTracks([]);
        }
      } catch (e) {
        console.error("Failed to load tag detail:", e);
        if (!cancelled) {
          setTag(null);
          setTracks([]);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [name, loadKey]);

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
        default: return 0;
      }
    });
    return sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, sortField, sortDir, shuffleKey]);

  const handleToggleTagLike = useCallback(() => {
    if (!tag) return;
    const newLiked = tag.liked === 1 ? 0 : 1;
    invoke("toggle_liked", { kind: "tag", id: tag.id, liked: newLiked })
      .then(() => setTag(prev => prev ? { ...prev, liked: newLiked } : null))
      .catch((e) => console.error("Failed to toggle tag like:", e));
  }, [tag]);

  const handleToggleTagDislike = useCallback(() => {
    if (!tag) return;
    const newLiked = tag.liked === -1 ? 0 : -1;
    invoke("toggle_liked", { kind: "tag", id: tag.id, liked: newLiked })
      .then(() => setTag(prev => prev ? { ...prev, liked: newLiked } : null))
      .catch((e) => console.error("Failed to toggle tag dislike:", e));
  }, [tag]);

  const reload = useCallback(() => {
    setLoadKey(k => k + 1);
  }, []);

  return {
    tag,
    tracks,
    sortedTracks,
    isLibrary: tag !== null,
    sortField,
    handleSort,
    sortIndicator,
    handleToggleTagLike,
    handleToggleTagDislike,
    reload,
  };
}
