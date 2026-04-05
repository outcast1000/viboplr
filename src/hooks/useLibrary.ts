import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Artist, Album, Tag, Track, Collection, CollectionStats, View, ViewMode, SortField, SortDir, ArtistSortField, AlbumSortField, TagSortField, ColumnConfig, TrackColumnId } from "../types";
import { store } from "../store";

const ALL_COLUMN_IDS: TrackColumnId[] = ["like", "num", "title", "artist", "album", "year", "quality", "duration", "popularity", "size", "collection", "added", "modified", "path"];

const DEFAULT_VISIBLE: Set<TrackColumnId> = new Set(["like", "num", "title", "artist", "album", "duration"]);

export const DEFAULT_TRACK_COLUMNS: ColumnConfig[] = ALL_COLUMN_IDS.map(id => ({
  id,
  visible: DEFAULT_VISIBLE.has(id),
}));

export function useLibrary(restoredRef: React.RefObject<boolean>, onBeforeNavigate?: () => void, debouncedTrackQuery?: string, trackPopularity?: Record<number, number>) {
  const [view, setView] = useState<View>("all");
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
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null);
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

  // Artist sort state
  const [artistSortField, setArtistSortField] = useState<ArtistSortField | null>(null);
  const [artistSortDir, setArtistSortDir] = useState<SortDir>("asc");
  const [artistLikedFirst, setArtistLikedFirst] = useState(false);
  const [artistShuffleKey, setArtistShuffleKey] = useState(0);

  // Album sort state
  const [albumSortField, setAlbumSortField] = useState<AlbumSortField | null>(null);
  const [albumSortDir, setAlbumSortDir] = useState<SortDir>("asc");
  const [albumLikedFirst, setAlbumLikedFirst] = useState(false);
  const [albumShuffleKey, setAlbumShuffleKey] = useState(0);

  // Track shuffle key (forces re-fetch on shuffle click)
  const [trackShuffleKey, setTrackShuffleKey] = useState(0);

  // Track filters
  const [filterYoutubeOnly, setFilterYoutubeOnly] = useState(false);
  const [mediaTypeFilter, setMediaTypeFilter] = useState<"all" | "audio" | "video">("all");
  const [trackLikedFirst, setTrackLikedFirst] = useState(false);
  const [searchIncludeLyrics, setSearchIncludeLyrics] = useState(true);

  // Tag sort state
  const [tagSortField, setTagSortField] = useState<TagSortField | null>(null);
  const [tagSortDir, setTagSortDir] = useState<SortDir>("asc");
  const [tagLikedFirst, setTagLikedFirst] = useState(false);
  const [tagShuffleKey, setTagShuffleKey] = useState(0);

  // View mode state
  const [artistViewMode, setArtistViewMode] = useState<ViewMode>("tiles");
  const [albumViewMode, setAlbumViewMode] = useState<ViewMode>("tiles");
  const [tagViewMode, setTagViewMode] = useState<ViewMode>("tiles");
  const [trackViewMode, setTrackViewMode] = useState<ViewMode>("basic");
  const [likedViewMode, setLikedViewMode] = useState<ViewMode>("basic");
  const [sortBarCollapsed, setSortBarCollapsed] = useState(false);

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
  useEffect(() => { if (restoredRef.current) store.set("artistViewMode", artistViewMode); }, [artistViewMode]);
  useEffect(() => { if (restoredRef.current) store.set("albumViewMode", albumViewMode); }, [albumViewMode]);
  useEffect(() => { if (restoredRef.current) store.set("tagViewMode", tagViewMode); }, [tagViewMode]);
  useEffect(() => { if (restoredRef.current) store.set("trackViewMode", trackViewMode); }, [trackViewMode]);
  useEffect(() => { if (restoredRef.current) store.set("likedViewMode", likedViewMode); }, [likedViewMode]);
  useEffect(() => { if (restoredRef.current) store.set("sortBarCollapsed", sortBarCollapsed); }, [sortBarCollapsed]);
  // Persist per-view sort & filter state
  useEffect(() => { if (restoredRef.current) store.set("artistSortField", artistSortField); }, [artistSortField]);
  useEffect(() => { if (restoredRef.current) store.set("artistSortDir", artistSortDir); }, [artistSortDir]);
  useEffect(() => { if (restoredRef.current) store.set("artistLikedFirst", artistLikedFirst); }, [artistLikedFirst]);
  useEffect(() => { if (restoredRef.current) store.set("albumSortField", albumSortField); }, [albumSortField]);
  useEffect(() => { if (restoredRef.current) store.set("albumSortDir", albumSortDir); }, [albumSortDir]);
  useEffect(() => { if (restoredRef.current) store.set("albumLikedFirst", albumLikedFirst); }, [albumLikedFirst]);
  useEffect(() => { if (restoredRef.current) store.set("tagSortField", tagSortField); }, [tagSortField]);
  useEffect(() => { if (restoredRef.current) store.set("tagSortDir", tagSortDir); }, [tagSortDir]);
  useEffect(() => { if (restoredRef.current) store.set("tagLikedFirst", tagLikedFirst); }, [tagLikedFirst]);
  useEffect(() => { if (restoredRef.current) store.set("filterYoutubeOnly", filterYoutubeOnly); }, [filterYoutubeOnly]);
  useEffect(() => { if (restoredRef.current) store.set("mediaTypeFilter", mediaTypeFilter); }, [mediaTypeFilter]);
  useEffect(() => { if (restoredRef.current) store.set("trackLikedFirst", trackLikedFirst); }, [trackLikedFirst]);
  useEffect(() => { if (restoredRef.current) store.set("searchIncludeLyrics", searchIncludeLyrics); }, [searchIncludeLyrics]);

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
            likedOnly: view === "liked" ? true : undefined,
            sortField,
            sortDir,
            limit: PAGE_SIZE,
            offset,
            hasYoutubeUrl: filterYoutubeOnly,
            mediaType: mediaTypeFilter !== "all" ? mediaTypeFilter : undefined,
            includeLyrics: searchIncludeLyrics,
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
      } else if (view === "liked") {
        // Non-paginated: liked
        const results = await invoke<Track[]>("get_liked_tracks");
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
  }, [debouncedTrackQuery, selectedTag, selectedAlbum, selectedArtist, view, sortField, sortDir, trackShuffleKey, filterYoutubeOnly, mediaTypeFilter, searchIncludeLyrics]);

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
    (selectedTag === null && selectedAlbum === null && selectedArtist === null && view !== "liked");

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
    if (sortField === field) {
      if (sortDir === "asc") {
        setSortDir("desc");
      } else {
        setSortField(null);
        setSortDir("asc");
      }
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  function sortIndicator(field: SortField): string {
    if (sortField !== field) return "";
    return sortDir === "asc" ? " \u25B2" : " \u25BC";
  }

  const sortedTracks = (() => {
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
          case "path": return (a.path.localeCompare(b.path)) * dir;
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
          case "popularity": return ((trackPopularity?.[a.id] ?? 0) - (trackPopularity?.[b.id] ?? 0)) * dir;
          default: return 0;
        }
      });
      result = sorted;
    }
    if (trackLikedFirst) {
      result = [...result].sort((a, b) => (b.liked - a.liked));
    }
    return result;
  })();

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
        const el = document.querySelector(`[data-track-id="${sortedTracks[idx].id}"]`) ??
                   document.querySelector(`.track-row:nth-child(${idx + 1})`);
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
  }, [sortedTracks]);

  // Fisher-Yates shuffle helper
  function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const sortedArtists = useMemo(() => {
    void artistShuffleKey; // trigger re-compute on shuffle
    let result: Artist[];
    if (artistSortField === "random") {
      result = shuffle(artists);
    } else if (artistSortField === "name") {
      const dir = artistSortDir === "asc" ? 1 : -1;
      result = [...artists].sort((a, b) => a.name.localeCompare(b.name) * dir);
    } else if (artistSortField === "tracks") {
      const dir = artistSortDir === "asc" ? 1 : -1;
      result = [...artists].sort((a, b) => (a.track_count - b.track_count) * dir);
    } else {
      result = artists;
    }
    if (artistLikedFirst) {
      result = [...result].sort((a, b) => (b.liked - a.liked));
    }
    return result;
  }, [artists, artistSortField, artistSortDir, artistLikedFirst, artistShuffleKey]);

  const sortedAlbums = useMemo(() => {
    void albumShuffleKey;
    let result: Album[];
    if (albumSortField === "random") {
      result = shuffle(albums);
    } else if (albumSortField === "name") {
      const dir = albumSortDir === "asc" ? 1 : -1;
      result = [...albums].sort((a, b) => a.title.localeCompare(b.title) * dir);
    } else if (albumSortField === "artist") {
      const dir = albumSortDir === "asc" ? 1 : -1;
      result = [...albums].sort((a, b) => (a.artist_name ?? "").localeCompare(b.artist_name ?? "") * dir);
    } else if (albumSortField === "year") {
      const dir = albumSortDir === "asc" ? 1 : -1;
      result = [...albums].sort((a, b) => ((a.year ?? 0) - (b.year ?? 0)) * dir);
    } else if (albumSortField === "tracks") {
      const dir = albumSortDir === "asc" ? 1 : -1;
      result = [...albums].sort((a, b) => (a.track_count - b.track_count) * dir);
    } else {
      result = albums;
    }
    if (albumLikedFirst) {
      result = [...result].sort((a, b) => (b.liked - a.liked));
    }
    return result;
  }, [albums, albumSortField, albumSortDir, albumLikedFirst, albumShuffleKey]);

  const sortedTags = useMemo(() => {
    void tagShuffleKey;
    let result: Tag[];
    if (tagSortField === "random") {
      result = shuffle(tags);
    } else if (tagSortField === "name") {
      const dir = tagSortDir === "asc" ? 1 : -1;
      result = [...tags].sort((a, b) => a.name.localeCompare(b.name) * dir);
    } else if (tagSortField === "tracks") {
      const dir = tagSortDir === "asc" ? 1 : -1;
      result = [...tags].sort((a, b) => (a.track_count - b.track_count) * dir);
    } else {
      result = tags;
    }
    if (tagLikedFirst) {
      result = [...result].sort((a, b) => (b.liked - a.liked));
    }
    return result;
  }, [tags, tagSortField, tagSortDir, tagLikedFirst, tagShuffleKey]);

  function handleTagSort(field: TagSortField) {
    if (field === "random") {
      if (tagSortField === "random") {
        setTagSortField(null);
        setTagSortDir("asc");
      } else {
        setTagSortField("random");
        setTagShuffleKey(k => k + 1);
      }
      return;
    }
    if (tagSortField === field) {
      if (tagSortDir === "asc") {
        setTagSortDir("desc");
      } else {
        setTagSortField(null);
        setTagSortDir("asc");
      }
    } else {
      setTagSortField(field);
      setTagSortDir("asc");
    }
  }

  function handleArtistSort(field: ArtistSortField) {
    if (field === "random") {
      if (artistSortField === "random") {
        setArtistSortField(null);
        setArtistSortDir("asc");
      } else {
        setArtistSortField("random");
        setArtistShuffleKey(k => k + 1);
      }
      return;
    }
    if (artistSortField === field) {
      if (artistSortDir === "asc") {
        setArtistSortDir("desc");
      } else {
        setArtistSortField(null);
        setArtistSortDir("asc");
      }
    } else {
      setArtistSortField(field);
      setArtistSortDir("asc");
    }
  }

  function handleAlbumSort(field: AlbumSortField) {
    if (field === "random") {
      if (albumSortField === "random") {
        setAlbumSortField(null);
        setAlbumSortDir("asc");
      } else {
        setAlbumSortField("random");
        setAlbumShuffleKey(k => k + 1);
      }
      return;
    }
    if (albumSortField === field) {
      if (albumSortDir === "asc") {
        setAlbumSortDir("desc");
      } else {
        setAlbumSortField(null);
        setAlbumSortDir("asc");
      }
    } else {
      setAlbumSortField(field);
      setAlbumSortDir("asc");
    }
  }

  function handleTrackClick(trackId: number) {
    onBeforeNavigate?.();
    setSelectedTrack(trackId);
  }

  function handleArtistClick(artistId: number) {
    onBeforeNavigate?.();
    setSelectedArtist(artistId);
    setSelectedAlbum(null);
    setSelectedTag(null);
    setSelectedTrack(null);
    setView("artists");
  }

  function handleAlbumClick(albumId: number, artistId?: number | null) {
    onBeforeNavigate?.();
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

  function handleShowAll() {
    onBeforeNavigate?.();
    setView("all");
    setSelectedArtist(null);
    setSelectedAlbum(null);
    setSelectedTag(null);
    setSelectedTrack(null);
  }

  function handleShowLiked() {
    onBeforeNavigate?.();
    setView("liked");
    setSelectedArtist(null);
    setSelectedAlbum(null);
    setSelectedTag(null);
    setSelectedTrack(null);
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
    handleTrackClick, handleArtistClick, handleAlbumClick, handleLocateTrack, handleShowAll, handleShowLiked,
    loadLibrary, loadTracks,
    hasMore, loadingMore, loadMore,
    sortedArtists, artistSortField, setArtistSortField, artistSortDir, setArtistSortDir, artistLikedFirst, setArtistLikedFirst, handleArtistSort,
    sortedAlbums, albumSortField, setAlbumSortField, albumSortDir, setAlbumSortDir, albumLikedFirst, setAlbumLikedFirst, handleAlbumSort,
    sortedTags, tagSortField, setTagSortField, tagSortDir, setTagSortDir, tagLikedFirst, setTagLikedFirst, handleTagSort,
    filterYoutubeOnly, setFilterYoutubeOnly, mediaTypeFilter, setMediaTypeFilter, trackLikedFirst, setTrackLikedFirst, searchIncludeLyrics, setSearchIncludeLyrics,
    artistViewMode, setArtistViewMode,
    albumViewMode, setAlbumViewMode,
    tagViewMode, setTagViewMode,
    trackViewMode, setTrackViewMode,
    likedViewMode, setLikedViewMode,
    sortBarCollapsed, setSortBarCollapsed,
  };
}
