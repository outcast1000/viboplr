import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Artist, Album, Tag, Track, Collection, CollectionStats, View, ViewMode, SortField, SortDir, ColumnConfig, TrackColumnId } from "../types";
import { store } from "../store";

const ALL_COLUMN_IDS: TrackColumnId[] = ["like", "num", "title", "artist", "album", "year", "quality", "duration", "popularity", "size", "collection", "added", "modified", "path"];

const DEFAULT_VISIBLE: Set<TrackColumnId> = new Set(["like", "num", "title", "artist", "album", "duration"]);

export const DEFAULT_TRACK_COLUMNS: ColumnConfig[] = ALL_COLUMN_IDS.map(id => ({
  id,
  visible: DEFAULT_VISIBLE.has(id),
}));

const ARTIST_DETAIL_VISIBLE: Set<TrackColumnId> = new Set(["like", "num", "title", "album", "duration", "popularity"]);
const ALBUM_DETAIL_VISIBLE: Set<TrackColumnId> = new Set(["like", "num", "title", "duration", "popularity"]);
const TAG_DETAIL_VISIBLE: Set<TrackColumnId> = new Set(["like", "num", "title", "artist", "album", "duration"]);

export const ARTIST_DETAIL_COLUMNS: ColumnConfig[] = ALL_COLUMN_IDS.map(id => ({
  id,
  visible: ARTIST_DETAIL_VISIBLE.has(id),
}));

export const ALBUM_DETAIL_COLUMNS: ColumnConfig[] = ALL_COLUMN_IDS.map(id => ({
  id,
  visible: ALBUM_DETAIL_VISIBLE.has(id),
}));

export const TAG_DETAIL_COLUMNS: ColumnConfig[] = ALL_COLUMN_IDS.map(id => ({
  id,
  visible: TAG_DETAIL_VISIBLE.has(id),
}));

export function useLibrary(restoredRef: React.RefObject<boolean>, onBeforeNavigate?: () => void, getDebouncedTrackQuery?: (view: View) => string, trackPopularity?: Record<number, number>, onNavigationError?: (message: string) => void) {
  const [view, setView] = useState<View>("search");
  const debouncedTrackQuery = getDebouncedTrackQuery?.(view) ?? "";
  const [artists, setArtists] = useState<Artist[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionStats, setCollectionStats] = useState<CollectionStats[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [trackCount, setTrackCount] = useState(0);
  const [albumCount, setAlbumCount] = useState(0);
  const [selectedArtist, setSelectedArtist] = useState<number | null>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<number | null>(null);
  const [selectedTag, setSelectedTag] = useState<number | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<string | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [highlightedListIndex, setHighlightedListIndex] = useState(-1);
  const pendingLocateRef = useRef<{ title: string; artistName: string | null } | null>(null);

  // Pagination state
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const PAGE_SIZE = 100;
  const tracksRef = useRef<Track[]>([]);
  // Sort state
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Column config state
  const [trackColumns, setTrackColumns] = useState<ColumnConfig[]>(DEFAULT_TRACK_COLUMNS);

  // Track shuffle key (forces re-fetch on shuffle click)
  const [trackShuffleKey, setTrackShuffleKey] = useState(0);

  // Track filters
  const [filterYoutubeOnly, setFilterYoutubeOnly] = useState(false);
  const [mediaTypeFilter, setMediaTypeFilter] = useState<"all" | "audio" | "video">("all");
  const [trackLikedFirst, setTrackLikedFirst] = useState(false);

  // View mode state
  const [trackViewMode, setTrackViewMode] = useState<ViewMode>("basic");

  // Artist-filtered albums for artist detail view (derived, never mutates albums state)
  const artistAlbums = useMemo(() => {
    if (selectedArtist === null) return [];
    return albums.filter(a => a.artist_id === selectedArtist)
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  }, [albums, selectedArtist]);

  // Persist state
  useEffect(() => { if (restoredRef.current) store.set("view", view); }, [view]);
  useEffect(() => { if (restoredRef.current) store.set("selectedArtist", selectedArtist); }, [selectedArtist]);
  useEffect(() => { if (restoredRef.current) store.set("selectedAlbum", selectedAlbum); }, [selectedAlbum]);
  useEffect(() => { if (restoredRef.current) store.set("selectedTag", selectedTag); }, [selectedTag]);
  useEffect(() => { if (restoredRef.current) store.set("selectedTrack", selectedTrack); }, [selectedTrack]);
  useEffect(() => { if (restoredRef.current) store.set("trackSortField", sortField); }, [sortField]);
  useEffect(() => { if (restoredRef.current) store.set("trackSortDir", sortDir); }, [sortDir]);
  useEffect(() => { if (restoredRef.current) store.set("trackColumns", trackColumns); }, [trackColumns]);
  useEffect(() => { if (restoredRef.current) store.set("trackViewMode", trackViewMode); }, [trackViewMode]);
  useEffect(() => { if (restoredRef.current) store.set("filterYoutubeOnly", filterYoutubeOnly); }, [filterYoutubeOnly]);
  useEffect(() => { if (restoredRef.current) store.set("mediaTypeFilter", mediaTypeFilter); }, [mediaTypeFilter]);
  useEffect(() => { if (restoredRef.current) store.set("trackLikedFirst", trackLikedFirst); }, [trackLikedFirst]);
  const loadLibrary = useCallback(async () => {
    try {
      const [a, al, c, cs, t, tc] = await Promise.all([
        invoke<Artist[]>("get_artists"),
        invoke<Album[]>("get_albums", { artistId: null }),
        invoke<Collection[]>("get_collections"),
        invoke<CollectionStats[]>("get_collection_stats"),
        invoke<Tag[]>("get_tags"),
        invoke<number>("get_track_count"),
      ]);
      setArtists(a);
      setAlbums(al);
      setAlbumCount(al.length);
      setCollections(c);
      setCollectionStats(cs);
      setTags(t);
      setTrackCount(tc);
    } catch (e) {
      console.error("Failed to load library:", e);
    }
  }, []);

  const loadTracks = useCallback(async (append = false) => {
    try {
      // No tracks rendered on album grid or tag list
      if ((view === "albums" && selectedAlbum === null) || (view === "tags" && selectedTag === null)) {
        if (!(debouncedTrackQuery ?? "").trim()) { setTracks([]); tracksRef.current = []; setHasMore(false); return; }
      }

      const offset = append ? tracksRef.current.length : 0;

      if ((debouncedTrackQuery ?? "").trim()) {
        // Paginated path: search
        const results = await invoke<Track[]>("get_tracks", {
          opts: {
            query: debouncedTrackQuery ?? "",
            artistId: selectedArtist,
            albumId: selectedAlbum,
            tagId: selectedTag,
            likedOnly: undefined,
            sortField,
            sortDir,
            limit: PAGE_SIZE,
            offset,
            hasYoutubeUrl: filterYoutubeOnly,
            mediaType: mediaTypeFilter !== "all" ? mediaTypeFilter : undefined,
          },
        });
        if (append) {
          const newTracks = [...tracksRef.current, ...results];
          setTracks(newTracks);
          tracksRef.current = newTracks;
        } else {
          setTracks(results);
          tracksRef.current = results;
        }
        setHasMore(results.length === PAGE_SIZE);
      } else if (selectedTag !== null) {
        // Non-paginated: by tag
        const results = await invoke<Track[]>("get_tracks_by_tag", { tagId: selectedTag });
        setTracks(results);
        tracksRef.current = results;
        setHasMore(false);
      } else if (selectedAlbum !== null) {
        // Non-paginated: by album
        const results = await invoke<Track[]>("get_tracks", { opts: { albumId: selectedAlbum } });
        setTracks(results);
        tracksRef.current = results;
        setHasMore(false);
      } else if (selectedArtist !== null) {
        // Non-paginated: by artist
        const results = await invoke<Track[]>("get_tracks_by_artist", { artistId: selectedArtist });
        setTracks(results);
        tracksRef.current = results;
        setHasMore(false);
      } else {
        // Paginated path: all tracks
        const results = await invoke<Track[]>("get_tracks", {
          opts: {
            sortField,
            sortDir,
            limit: PAGE_SIZE,
            offset,
            hasYoutubeUrl: filterYoutubeOnly,
            mediaType: mediaTypeFilter !== "all" ? mediaTypeFilter : undefined,
          },
        });
        if (append) {
          const newTracks = [...tracksRef.current, ...results];
          setTracks(newTracks);
          tracksRef.current = newTracks;
        } else {
          setTracks(results);
          tracksRef.current = results;
        }
        setHasMore(results.length === PAGE_SIZE);
      }
    } catch (e) {
      console.error("Failed to load tracks:", e);
    }
  }, [debouncedTrackQuery, selectedTag, selectedAlbum, selectedArtist, view, sortField, sortDir, trackShuffleKey, filterYoutubeOnly, mediaTypeFilter]);

  useEffect(() => { loadTracks(); }, [loadTracks]);


  // Reset highlighted index when tracks change
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [tracks]);

  // Reset list highlight when search or view changes
  useEffect(() => { setHighlightedListIndex(-1); }, [debouncedTrackQuery, view, selectedArtist, selectedAlbum, selectedTag]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    await loadTracks(true);
    setLoadingMore(false);
  }, [loadTracks, loadingMore, hasMore]);

  // Server handles sorting for paginated views; skip client-side sort
  const isServerSorted = (debouncedTrackQuery ?? "").trim() !== "" ||
    (selectedTag === null && selectedAlbum === null && selectedArtist === null);

  function handleSort(field: SortField) {
    if (field === "random") {
      if (sortField === "random") {
        setSortField(null);
        setSortDir("asc");
      } else {
        setSortField("random");
        setSortDir("asc");
      }
      setTrackShuffleKey(k => k + 1);
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
  }

  function sortIndicator(field: SortField): string {
    if (sortField !== field) return "";
    return sortDir === "asc" ? " \u25B2" : " \u25BC";
  }

  const sortedTracks = useMemo(() => {
    let result = tracks;
    if (!isServerSorted && sortField) {
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
          case "popularity": return ((trackPopularity?.[(a.id ?? 0)] ?? 0) - (trackPopularity?.[(b.id ?? 0)] ?? 0)) * dir;
          default: return 0;
        }
      });
      result = sorted;
    }
    if (trackLikedFirst) {
      result = [...result].sort((a, b) => (b.liked - a.liked));
    }
    return result;
  }, [tracks, isServerSorted, sortField, sortDir, trackLikedFirst, trackPopularity]);

  // Resolve pending locate-track after sortedTracks updates
  useEffect(() => {
    const locate = pendingLocateRef.current;
    if (!locate) return;
    pendingLocateRef.current = null;
    const idx = sortedTracks.findIndex(t =>
      t.title.toLowerCase() === locate.title.toLowerCase() &&
      (t.artist_name ?? "").toLowerCase() === (locate.artistName ?? "").toLowerCase()
    );
    if (idx >= 0) {
      setHighlightedIndex(idx);
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-track-id="${sortedTracks[idx].key}"]`) ??
                   document.querySelector(`.track-row:nth-child(${idx + 1})`);
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
  }, [sortedTracks]);

  function handleTrackClick(trackKey: string) {
    onBeforeNavigate?.();
    clearFallback();
    setSelectedTrack(trackKey);
  }

  function handleArtistClick(artistId: number) {
    if (!artistId || !artists.find(a => a.id === artistId)) {
      onNavigationError?.("This artist is not available in the library. It may belong to a multi-artist compilation or an external source.");
      return;
    }
    onBeforeNavigate?.();
    clearFallback();
    setSelectedArtist(artistId);
    setSelectedAlbum(null);
    setSelectedTag(null);
    setSelectedTrack(null);
    setView("artists");
  }

  function handleAlbumClick(albumId: number, artistId?: number | null) {
    if (!albumId || !albums.find(a => a.id === albumId)) {
      onNavigationError?.("This album is not available in the library. It may belong to a multi-artist compilation or an external source.");
      return;
    }
    onBeforeNavigate?.();
    clearFallback();
    setSelectedAlbum(albumId);
    setSelectedTag(null);
    setSelectedTrack(null);
    const resolvedArtistId = artistId !== undefined ? artistId
      : albums.find(a => a.id === albumId)?.artist_id ?? null;
    if (resolvedArtistId) {
      setSelectedArtist(resolvedArtistId);
      setView("artists");
    } else {
      setSelectedArtist(null);
      setView("albums");
    }
  }

  // Fallback state for non-library entities (just a name, shown with info sections only)
  const [fallbackArtistName, setFallbackArtistName] = useState<string | null>(null);
  const [fallbackAlbumName, setFallbackAlbumName] = useState<{ name: string; artistName?: string } | null>(null);
  const [fallbackTrackName, setFallbackTrackName] = useState<{ name: string; artistName?: string } | null>(null);

  function clearFallback() {
    setFallbackArtistName(null);
    setFallbackAlbumName(null);
    setFallbackTrackName(null);
  }

  async function navigateToArtistByName(name: string) {
    const result = await invoke<Artist | null>("find_artist_by_name", { name });
    if (result) {
      handleArtistClick(result.id);
    } else {
      onBeforeNavigate?.();
      setSelectedArtist(null);
      setSelectedAlbum(null);
      setSelectedTag(null);
      setSelectedTrack(null);
      clearFallback();
      setFallbackArtistName(name);
      setView("artists");
    }
  }

  async function navigateToAlbumByName(name: string, artistName?: string) {
    const result = await invoke<Album | null>("find_album_by_name", { title: name, artistName: artistName ?? null });
    if (result) {
      handleAlbumClick(result.id, result.artist_id);
    } else {
      onBeforeNavigate?.();
      setSelectedArtist(null);
      setSelectedAlbum(null);
      setSelectedTag(null);
      setSelectedTrack(null);
      clearFallback();
      setFallbackAlbumName({ name, artistName });
      setView("albums");
    }
  }

  async function navigateToTrackByName(name: string, artistName?: string, albumTitle?: string) {
    const result = await invoke<Track | null>("find_track_by_metadata", { title: name, artistName: artistName ?? null, albumName: albumTitle ?? null });
    if (result) {
      handleTrackClick(result.key);
    } else {
      onBeforeNavigate?.();
      setSelectedArtist(null);
      setSelectedAlbum(null);
      setSelectedTag(null);
      setSelectedTrack(null);
      clearFallback();
      setFallbackTrackName({ name, artistName });
    }
  }

  function handleLocateTrack(title: string, artistName: string | null, albumTitle: string | null, searchAllFallback?: () => void) {
    pendingLocateRef.current = { title, artistName };
    const matchedArtist = artistName
      ? artists.find(a => a.name.toLowerCase() === artistName.toLowerCase())
      : null;
    const matchedAlbum = albumTitle && matchedArtist
      ? albums.find(a => a.title.toLowerCase() === albumTitle.toLowerCase() && a.artist_id === matchedArtist.id)
      : null;
    if (matchedAlbum && matchedArtist) {
      handleAlbumClick(matchedAlbum.id, matchedArtist.id);
    } else if (matchedArtist) {
      handleArtistClick(matchedArtist.id);
    } else if (searchAllFallback) {
      searchAllFallback();
    }
  }

  return {
    view, setView,
    artists, setArtists,
    albums, setAlbums,
    tracks, setTracks,
    collections, setCollections,
    collectionStats,
    tags, setTags,
    trackCount, albumCount,
    selectedArtist, setSelectedArtist,
    selectedAlbum, setSelectedAlbum,
    selectedTag, setSelectedTag,
    selectedTrack, setSelectedTrack,
    highlightedIndex, setHighlightedIndex,
    highlightedListIndex, setHighlightedListIndex,
    sortField, sortDir, setSortField, setSortDir,
    sortedTracks,
    handleSort, sortIndicator,
    trackColumns, setTrackColumns,
    artistAlbums,
    handleTrackClick, handleArtistClick, handleAlbumClick, handleLocateTrack,
    fallbackArtistName, setFallbackArtistName,
    fallbackAlbumName, setFallbackAlbumName,
    fallbackTrackName, setFallbackTrackName,
    navigateToArtistByName, navigateToAlbumByName, navigateToTrackByName,
    loadLibrary, loadTracks,
    hasMore, loadingMore, loadMore,
    filterYoutubeOnly, setFilterYoutubeOnly, mediaTypeFilter, setMediaTypeFilter, trackLikedFirst, setTrackLikedFirst,
    trackViewMode, setTrackViewMode,
  };
}
