import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, Artist, Album, Tag, ViewMode, SortField } from "../types";
import { formatDuration, isVideoTrack } from "../utils";
import { store } from "../store";
import { isLocalTrack } from "../queueEntry";
import { TrackList } from "./TrackList";
import { ArtistCardArt } from "./ArtistCardArt";
import { AlbumCardArt } from "./AlbumCardArt";
import { TagCardArt } from "./TagCardArt";
import { ViewModeToggle } from "./ViewModeToggle";
import { VideoRowThumb } from "./VideoRowThumb";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { toggleSortKey, chainPosition, chainDir, type SortKey, type SortDir } from "../sortChain";

function isLocalVideo(t: Track): boolean {
  if (!isVideoTrack(t)) return false;
  if (t.id == null) return false;
  return isLocalTrack(t);
}

interface SearchSettings {
  activeTab: SearchTab;
  sortField?: string | null;
  sortDir?: SortDir;
  trackLikedFirst?: boolean;
  artistSortField?: string | null;
  artistSortDir?: SortDir;
  artistLikedFirst?: boolean;
  albumSortField?: string | null;
  albumSortDir?: SortDir;
  albumLikedFirst?: boolean;
  tagSortField?: string | null;
  tagSortDir?: SortDir;
  tagLikedFirst?: boolean;
  trackSortChain?: SortKey[];
  artistSortChain?: SortKey[];
  albumSortChain?: SortKey[];
  tagSortChain?: SortKey[];
  mediaTypeFilter: MediaTypeFilter;
  filterYoutubeOnly: boolean;
  sortBarCollapsed: boolean;
}
type MediaTypeFilter = "all" | "audio" | "video";

type SearchTab = "tracks" | "albums" | "artists" | "tags";

interface SearchEntityResult {
  tracks: Track[] | null;
  albums: Album[] | null;
  artists: Artist[] | null;
  tags: Tag[] | null;
  total: number;
}

interface SearchViewModes {
  tracks: ViewMode;
  albums: ViewMode;
  artists: ViewMode;
  tags: ViewMode;
}

interface SearchViewProps {
  initialQuery: string | null;
  initialQueryKey: number;
  deletedTrackIds: number[];
  deletedTrackKey: number;
  currentTrack: Track | null;
  playing: boolean;
  viewModes: SearchViewModes;
  onViewModesChange: (modes: SearchViewModes) => void;
  artistImages: Record<number, string | null>;
  albumImages: Record<number, string | null>;
  onPlayTracks: (tracks: Track[], index: number) => void;
  onArtistClick: (id: number) => void;
  onAlbumClick: (id: number, artistId?: number | null) => void;
  onTrackContextMenu: (e: React.MouseEvent, track: Track, selectedIds: Set<string>) => void;
  onArtistContextMenu: (e: React.MouseEvent, id: number) => void;
  onAlbumContextMenu: (e: React.MouseEvent, id: number) => void;
  onToggleLike: (track: Track) => void;
  onToggleDislike: (track: Track) => void;
  onToggleArtistLike: (id: number) => void;
  onToggleAlbumLike: (id: number) => void;
  onTrackDragStart: (tracks: Track[]) => void;
  onTagClick: (id: number) => void;
  onToggleTagLike: (id: number) => void;
  onFetchArtistImage: (artist: Artist) => void;
  onFetchAlbumImage: (album: Album) => void;
  onFetchTagImage: (tag: { id: number }) => void;
  tagImages: Record<number, string | null>;
  columns: import("../types").ColumnConfig[];
  onColumnsChange: (columns: import("../types").ColumnConfig[]) => void;
}

const TRACK_PAGE_SIZE = 50;
const ENTITY_PAGE_SIZE = 40;

export function SearchView({
  initialQuery,
  initialQueryKey,
  deletedTrackIds,
  deletedTrackKey,
  currentTrack,
  playing,
  viewModes,
  onViewModesChange,
  artistImages,
  albumImages,
  onPlayTracks,
  onArtistClick,
  onAlbumClick,
  onTrackContextMenu,
  onArtistContextMenu,
  onAlbumContextMenu,
  onToggleLike,
  onToggleDislike,
  onToggleArtistLike,
  onToggleAlbumLike,
  onTrackDragStart,
  onTagClick,
  onToggleTagLike,
  onFetchArtistImage,
  onFetchAlbumImage,
  onFetchTagImage,
  tagImages,
  columns,
  onColumnsChange,
}: SearchViewProps) {
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<SearchTab>("tracks");
  const [results, setResults] = useState<{ tracks: Track[]; albums: Album[]; artists: Artist[]; tags: Tag[] }>({ tracks: [], albums: [], artists: [], tags: [] });
  const [counts, setCounts] = useState({ tracks: 0, albums: 0, artists: 0, tags: 0 });
  const [hasMore, setHasMore] = useState({ tracks: false, albums: false, artists: false, tags: false });
  const [loadingMore, setLoadingMore] = useState({ tracks: false, albums: false, artists: false, tags: false });
  const [searched, setSearched] = useState(false);
  const [trackSortChain, setTrackSortChain] = useState<SortKey[]>([]);
  const [artistSortChain, setArtistSortChain] = useState<SortKey[]>([]);
  const [albumSortChain, setAlbumSortChain] = useState<SortKey[]>([]);
  const [tagSortChain, setTagSortChain] = useState<SortKey[]>([]);
  const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaTypeFilter>("all");
  const [filterYoutubeOnly, setFilterYoutubeOnly] = useState(false);
  const [sortBarCollapsed, setSortBarCollapsed] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const trackListRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const queryRef = useRef("");
  const sortRef = useRef({ trackSortChain, mediaTypeFilter, filterYoutubeOnly });
  sortRef.current = { trackSortChain, mediaTypeFilter, filterYoutubeOnly };
  const artistSortRef = useRef({ artistSortChain });
  artistSortRef.current = { artistSortChain };
  const albumSortRef = useRef({ albumSortChain });
  albumSortRef.current = { albumSortChain };
  const tagSortRef = useRef({ tagSortChain });
  tagSortRef.current = { tagSortChain };

  function getTrackFilterParams() {
    const s = sortRef.current;
    return {
      sortChain: s.trackSortChain.length > 0 ? s.trackSortChain : undefined,
      mediaType: s.mediaTypeFilter !== "all" ? s.mediaTypeFilter : undefined,
      hasYoutubeUrl: s.filterYoutubeOnly || undefined,
    };
  }

  function getArtistFilterParams() {
    return {
      sortChain: artistSortRef.current.artistSortChain.length > 0 ? artistSortRef.current.artistSortChain : undefined,
    };
  }

  function getAlbumFilterParams() {
    return {
      sortChain: albumSortRef.current.albumSortChain.length > 0 ? albumSortRef.current.albumSortChain : undefined,
    };
  }

  function getTagFilterParams() {
    return {
      sortChain: tagSortRef.current.tagSortChain.length > 0 ? tagSortRef.current.tagSortChain : undefined,
    };
  }

  const restoredRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    store.get<SearchSettings>("searchSettings").then(saved => {
      if (saved) {
        setActiveTab(saved.activeTab ?? "tracks");
        setMediaTypeFilter(saved.mediaTypeFilter ?? "all");
        setFilterYoutubeOnly(saved.filterYoutubeOnly ?? false);
        setSortBarCollapsed(saved.sortBarCollapsed ?? true);

        if (saved.trackSortChain) {
          setTrackSortChain(saved.trackSortChain);
        } else {
          const chain: SortKey[] = [];
          if (saved.trackLikedFirst) chain.push({ field: "liked", dir: "desc" });
          if (saved.sortField) chain.push({ field: saved.sortField, dir: saved.sortDir ?? "asc" });
          setTrackSortChain(chain);
        }

        if (saved.artistSortChain) {
          setArtistSortChain(saved.artistSortChain);
        } else {
          const chain: SortKey[] = [];
          if (saved.artistLikedFirst) chain.push({ field: "liked", dir: "desc" });
          if (saved.artistSortField) chain.push({ field: saved.artistSortField, dir: saved.artistSortDir ?? "asc" });
          setArtistSortChain(chain);
        }

        if (saved.albumSortChain) {
          setAlbumSortChain(saved.albumSortChain);
        } else {
          const chain: SortKey[] = [];
          if (saved.albumLikedFirst) chain.push({ field: "liked", dir: "desc" });
          if (saved.albumSortField) chain.push({ field: saved.albumSortField, dir: saved.albumSortDir ?? "asc" });
          setAlbumSortChain(chain);
        }

        if (saved.tagSortChain) {
          setTagSortChain(saved.tagSortChain);
        } else {
          const chain: SortKey[] = [];
          if (saved.tagLikedFirst) chain.push({ field: "liked", dir: "desc" });
          if (saved.tagSortField) chain.push({ field: saved.tagSortField, dir: saved.tagSortDir ?? "asc" });
          setTagSortChain(chain);
        }
      }
      restoredRef.current = true;
      doSearch("");
    });
  }, []);

  useEffect(() => {
    if (initialQuery) {
      setQuery(initialQuery);
      queryRef.current = initialQuery;
      doSearch(initialQuery);
    }
  }, [initialQueryKey]);

  useEffect(() => {
    if (deletedTrackKey === 0 || deletedTrackIds.length === 0) return;
    const deleted = new Set(deletedTrackIds);
    setResults(prev => {
      const filtered = prev.tracks.filter(t => t.id == null || !deleted.has(t.id));
      if (filtered.length === prev.tracks.length) return prev;
      return { ...prev, tracks: filtered };
    });
    setCounts(prev => ({
      ...prev,
      tracks: Math.max(0, prev.tracks - deletedTrackIds.length),
    }));
  }, [deletedTrackKey]);

  useEffect(() => {
    if (!restoredRef.current) return;
    refetchTracks();
  }, [trackSortChain, mediaTypeFilter, filterYoutubeOnly]);

  useEffect(() => {
    if (!restoredRef.current) return;
    refetchArtists();
  }, [artistSortChain]);

  useEffect(() => {
    if (!restoredRef.current) return;
    refetchAlbums();
  }, [albumSortChain]);

  useEffect(() => {
    if (!restoredRef.current) return;
    refetchTags();
  }, [tagSortChain]);

  useEffect(() => {
    if (!restoredRef.current) return;
    store.set("searchSettings", {
      activeTab, mediaTypeFilter, filterYoutubeOnly,
      trackSortChain, artistSortChain, albumSortChain, tagSortChain,
      sortBarCollapsed,
    });
  }, [activeTab, mediaTypeFilter, filterYoutubeOnly,
      trackSortChain, artistSortChain, albumSortChain, tagSortChain,
      sortBarCollapsed]);

  const refetchTracks = useCallback(async () => {
    if (!searched) return;
    const q = queryRef.current;
    const filters = getTrackFilterParams();
    const trackRes = await invoke<SearchEntityResult>("search_entity", {
      query: q, entity: "tracks", limit: TRACK_PAGE_SIZE, offset: 0, ...filters,
    });
    const tracks = trackRes.tracks ?? [];
    setResults(prev => ({ ...prev, tracks }));
    setCounts(prev => ({ ...prev, tracks: trackRes.total }));
    setHasMore(prev => ({ ...prev, tracks: tracks.length < trackRes.total }));
  }, [searched]);

  const refetchArtists = useCallback(async () => {
    if (!searched) return;
    const q = queryRef.current;
    const filters = getArtistFilterParams();
    const artistRes = await invoke<SearchEntityResult>("search_entity", {
      query: q, entity: "artists", limit: ENTITY_PAGE_SIZE, offset: 0, ...filters,
    });
    const artists = artistRes.artists ?? [];
    setResults(prev => ({ ...prev, artists }));
    setCounts(prev => ({ ...prev, artists: artistRes.total }));
    setHasMore(prev => ({ ...prev, artists: artists.length < artistRes.total }));
  }, [searched]);

  const refetchAlbums = useCallback(async () => {
    if (!searched) return;
    const q = queryRef.current;
    const filters = getAlbumFilterParams();
    const albumRes = await invoke<SearchEntityResult>("search_entity", {
      query: q, entity: "albums", limit: ENTITY_PAGE_SIZE, offset: 0, ...filters,
    });
    const albums = albumRes.albums ?? [];
    setResults(prev => ({ ...prev, albums }));
    setCounts(prev => ({ ...prev, albums: albumRes.total }));
    setHasMore(prev => ({ ...prev, albums: albums.length < albumRes.total }));
  }, [searched]);

  const refetchTags = useCallback(async () => {
    if (!searched) return;
    const q = queryRef.current;
    const filters = getTagFilterParams();
    const tagRes = await invoke<SearchEntityResult>("search_entity", {
      query: q, entity: "tags", limit: ENTITY_PAGE_SIZE, offset: 0, ...filters,
    });
    const tags = tagRes.tags ?? [];
    setResults(prev => ({ ...prev, tags }));
    setCounts(prev => ({ ...prev, tags: tagRes.total }));
    setHasMore(prev => ({ ...prev, tags: tags.length < tagRes.total }));
  }, [searched]);

  const doSearch = useCallback(async (q: string) => {
    setSearched(true);
    const trackFilters = getTrackFilterParams();
    const artistFilters = getArtistFilterParams();
    const albumFilters = getAlbumFilterParams();
    const tagFilters = getTagFilterParams();

    const [trackRes, albumRes, artistRes, tagRes] = await Promise.all([
      invoke<SearchEntityResult>("search_entity", { query: q, entity: "tracks", limit: TRACK_PAGE_SIZE, offset: 0, ...trackFilters }),
      invoke<SearchEntityResult>("search_entity", { query: q, entity: "albums", limit: ENTITY_PAGE_SIZE, offset: 0, ...albumFilters }),
      invoke<SearchEntityResult>("search_entity", { query: q, entity: "artists", limit: ENTITY_PAGE_SIZE, offset: 0, ...artistFilters }),
      invoke<SearchEntityResult>("search_entity", { query: q, entity: "tags", limit: ENTITY_PAGE_SIZE, offset: 0, ...tagFilters }),
    ]);

    if (queryRef.current !== q) return;

    const tracks = trackRes.tracks ?? [];
    const albums = albumRes.albums ?? [];
    const artists = artistRes.artists ?? [];
    const tags = tagRes.tags ?? [];

    setResults({ tracks, albums, artists, tags });
    setCounts({ tracks: trackRes.total, albums: albumRes.total, artists: artistRes.total, tags: tagRes.total });
    setHasMore({
      tracks: tracks.length < trackRes.total,
      albums: albums.length < albumRes.total,
      artists: artists.length < artistRes.total,
      tags: tags.length < tagRes.total,
    });
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    queryRef.current = val;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(val), 200);
  }, [doSearch]);

  const handleClear = useCallback(() => {
    setQuery("");
    queryRef.current = "";
    doSearch("");
    inputRef.current?.focus();
  }, [doSearch]);

  const handleLoadMore = useCallback(async () => {
    const tab = activeTab;
    const currentCount = results[tab].length;
    const pageSize = tab === "tracks" ? TRACK_PAGE_SIZE : ENTITY_PAGE_SIZE;

    setLoadingMore(prev => ({ ...prev, [tab]: true }));
    try {
      const filters = tab === "tracks" ? getTrackFilterParams() : tab === "artists" ? getArtistFilterParams() : tab === "albums" ? getAlbumFilterParams() : tab === "tags" ? getTagFilterParams() : {};
      const res = await invoke<SearchEntityResult>("search_entity", {
        query: queryRef.current,
        entity: tab,
        limit: pageSize,
        offset: currentCount,
        ...filters,
      });

      const newItems = tab === "tracks" ? (res.tracks ?? []) : tab === "albums" ? (res.albums ?? []) : tab === "artists" ? (res.artists ?? []) : (res.tags ?? []);
      setResults(prev => ({ ...prev, [tab]: [...prev[tab], ...newItems] }));
      setHasMore(prev => ({ ...prev, [tab]: currentCount + newItems.length < res.total }));
    } catch (e) {
      console.error("Failed to load more search results:", e);
    } finally {
      setLoadingMore(prev => ({ ...prev, [tab]: false }));
    }
  }, [activeTab, results]);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    onViewModesChange({ ...viewModes, [activeTab]: mode });
  }, [activeTab, viewModes, onViewModesChange]);

  const handleTrackSort = useCallback((field: string, e?: React.MouseEvent) => {
    setTrackSortChain(prev => toggleSortKey(prev, field, e?.shiftKey ?? false));
  }, []);

  const trackSortIndicator = useCallback((field: string) => {
    const dir = chainDir(trackSortChain, field);
    if (!dir) return "";
    return dir === "asc" ? " \u25B2" : " \u25BC";
  }, [trackSortChain]);

  const handleArtistSortClick = useCallback((field: string, e?: React.MouseEvent) => {
    setArtistSortChain(prev => toggleSortKey(prev, field, e?.shiftKey ?? false));
  }, []);

  const handleAlbumSortClick = useCallback((field: string, e?: React.MouseEvent) => {
    setAlbumSortChain(prev => toggleSortKey(prev, field, e?.shiftKey ?? false));
  }, []);

  const handleTagSortClick = useCallback((field: string, e?: React.MouseEvent) => {
    setTagSortChain(prev => toggleSortKey(prev, field, e?.shiftKey ?? false));
  }, []);

  const handleTrackLike = useCallback((track: Track) => {
    const newLiked = track.liked === 1 ? 0 : 1;
    setResults(prev => ({ ...prev, tracks: prev.tracks.map(t => t.key === track.key ? { ...t, liked: newLiked } : t) }));
    onToggleLike(track);
  }, [onToggleLike]);

  const handleTrackDislike = useCallback((track: Track) => {
    const newLiked = track.liked === -1 ? 0 : -1;
    setResults(prev => ({ ...prev, tracks: prev.tracks.map(t => t.key === track.key ? { ...t, liked: newLiked } : t) }));
    onToggleDislike(track);
  }, [onToggleDislike]);

  const tabs: { id: SearchTab; label: string; count: number }[] = [
    { id: "tracks", label: "Tracks", count: counts.tracks },
    { id: "albums", label: "Albums", count: counts.albums },
    { id: "artists", label: "Artists", count: counts.artists },
    { id: "tags", label: "Tags", count: counts.tags },
  ];

  return (
    <div className="search-view">
      <div className="search-view-input-wrapper">
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          className="search-view-input"
          type="text"
          placeholder="Search your library..."
          value={query}
          onChange={handleInputChange}
          spellCheck={false}
        />
        {query && (
          <button className="search-view-clear" onClick={handleClear} title="Clear">
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {searched && (
        <div className="ds-tabs" style={{ padding: "0 16px", gap: 4 }}>
          <div style={{ display: "flex", flex: 1 }}>
            {tabs.map(tab => (
              <button
                key={tab.id}
                className={`ds-tab ${activeTab === tab.id ? "active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
                {tab.count > 0 && <span className="ds-tab-badge">{tab.count}</span>}
              </button>
            ))}
          </div>
          <button className="sort-btn sort-bar-toggle" onClick={() => setSortBarCollapsed(v => !v)} title={sortBarCollapsed ? "Show sort bar" : "Hide sort bar"}>{sortBarCollapsed ? "\u25BC" : "\u25B2"}</button>
          <ViewModeToggle mode={viewModes[activeTab]} onChange={handleViewModeChange} />
        </div>
      )}

      <div className="search-view-results">
        {!searched && (
          <div className="search-view-empty">
            <svg width={48} height={48} viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <p>Search for tracks, albums, and artists</p>
          </div>
        )}

        {searched && activeTab === "tracks" && (
          <div className={`sort-bar-wrapper${sortBarCollapsed ? " collapsed" : ""}`}>
            <div className="sort-bar">
              <div className="sort-bar-row">
                <span className="sort-bar-label">Sort:</span>
                <div className="sort-bar-group">
                  <SortButton label="Title" field="title" chain={trackSortChain} onClick={handleTrackSort} />
                  <SortButton label="Artist" field="artist" chain={trackSortChain} onClick={handleTrackSort} />
                  <SortButton label="Album" field="album" chain={trackSortChain} onClick={handleTrackSort} />
                  <SortButton label="Year" field="year" chain={trackSortChain} onClick={handleTrackSort} />
                  <SortButton label="Duration" field="duration" chain={trackSortChain} onClick={handleTrackSort} />
                  <SortButton label="Added" field="added" chain={trackSortChain} onClick={handleTrackSort} />
                  <SortButton label="Modified" field="modified" chain={trackSortChain} onClick={handleTrackSort} />
                  <SortButton label={"\u2665 Liked"} field="liked" chain={trackSortChain} onClick={handleTrackSort} />
                  <SortButton label="Shuffle" field="random" chain={trackSortChain} onClick={handleTrackSort} />
                  {trackSortChain.length >= 2 && (
                    <button className="sort-btn sort-btn-clear" onClick={() => setTrackSortChain([])}>Clear</button>
                  )}
                </div>
              </div>
              <div className="sort-bar-row">
                <span className="sort-bar-label">Filter:</span>
                <div className="sort-bar-group sort-bar-group-filter">
                  <button className={`sort-btn${mediaTypeFilter === "all" ? " active" : ""}`} onClick={() => setMediaTypeFilter("all")}>All</button>
                  <button className={`sort-btn${mediaTypeFilter === "audio" ? " active" : ""}`} onClick={() => setMediaTypeFilter("audio")}>Audio</button>
                  <button className={`sort-btn${mediaTypeFilter === "video" ? " active" : ""}`} onClick={() => setMediaTypeFilter("video")}>Video</button>
                  <button className={`sort-btn${filterYoutubeOnly ? " active" : ""}`} onClick={() => setFilterYoutubeOnly(v => !v)}>YouTube</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {searched && activeTab === "tracks" && viewModes.tracks === "basic" && (
          <TrackList
            tracks={results.tracks}
            currentTrack={currentTrack}
            playing={playing}
            highlightedIndex={-1}
            sortField={trackSortChain.length === 1 ? trackSortChain[0].field as SortField : null}
            trackListRef={trackListRef}
            columns={columns}
            onColumnsChange={onColumnsChange}
            onDoubleClick={onPlayTracks}
            onContextMenu={onTrackContextMenu}
            onArtistClick={onArtistClick}
            onAlbumClick={onAlbumClick}
            onSort={handleTrackSort}
            sortIndicator={trackSortIndicator}
            onToggleLike={handleTrackLike}
            onToggleDislike={handleTrackDislike}
            onTrackDragStart={onTrackDragStart}
            emptyMessage="No tracks found."
            hasMore={hasMore.tracks}
            loadingMore={loadingMore.tracks}
            onLoadMore={handleLoadMore}
          />
        )}

        {searched && activeTab === "tracks" && viewModes.tracks === "list" && (
          <>
            <div className="entity-list">
              {results.tracks.map((t) => (
                <div
                  key={t.key}
                  className={`entity-list-item${currentTrack?.key === t.key ? " playing" : ""}`}
                  onDoubleClick={() => onPlayTracks([t], 0)}
                  onContextMenu={(e) => onTrackContextMenu(e, t, new Set())}
                >
                  <LikeDislikeButtons
                    liked={t.liked}
                    onToggleLike={() => handleTrackLike(t)}
                    onToggleDislike={() => handleTrackDislike(t)}
                    variant="inline"
                    size={12}
                  />
                  {isLocalVideo(t) ? (
                    <VideoRowThumb trackId={t.id!} alt={t.title} className="entity-list-img" />
                  ) : t.album_id ? (
                    <AlbumCardArt album={{ id: t.album_id, title: t.album_title ?? "", artist_name: t.artist_name } as Album} imagePath={albumImages[t.album_id]} onVisible={onFetchAlbumImage} />
                  ) : (
                    <div className="entity-list-img">{t.title[0]?.toUpperCase() ?? "?"}</div>
                  )}
                  <div className="entity-list-info">
                    <span className="entity-list-name">{t.title}</span>
                    <span className="entity-list-secondary">
                      {t.artist_name && (t.artist_id
                        ? <span className="track-link" onClick={(e) => { e.stopPropagation(); onArtistClick(t.artist_id!); }}>{t.artist_name}</span>
                        : <>{t.artist_name}</>
                      )}
                      {t.album_title && <> {"\u00B7"} {t.album_id
                        ? <span className="track-link" onClick={(e) => { e.stopPropagation(); onAlbumClick(t.album_id!, t.artist_id); }}>{t.album_title}</span>
                        : <>{t.album_title}</>
                      }</>}
                    </span>
                  </div>
                  <span className="entity-list-count">{formatDuration(t.duration_secs)}</span>
                </div>
              ))}
              {results.tracks.length === 0 && (
                <div className="empty">No tracks found.</div>
              )}
            </div>
            {hasMore.tracks && (
              <div className="search-view-load-more">
                <button onClick={handleLoadMore} disabled={loadingMore.tracks}>
                  {loadingMore.tracks ? "Loading..." : "Load More"}
                </button>
              </div>
            )}
          </>
        )}

        {searched && activeTab === "tracks" && viewModes.tracks === "tiles" && (
          <>
            <div className="tiles-scroll">
              <div className="album-grid">
                {results.tracks.map((t) => (
                  <div
                    key={t.key}
                    className={`album-card${currentTrack?.key === t.key ? " playing" : ""}`}
                    onDoubleClick={() => onPlayTracks([t], 0)}
                    onContextMenu={(e) => onTrackContextMenu(e, t, new Set())}
                  >
                    <div className="album-card-art-wrapper">
                    {isLocalVideo(t) ? (
                      <VideoRowThumb trackId={t.id!} alt={t.title} className="album-card-art" />
                    ) : t.album_id ? (
                      <AlbumCardArt album={{ id: t.album_id, title: t.album_title ?? "", artist_name: t.artist_name } as Album} imagePath={albumImages[t.album_id]} onVisible={onFetchAlbumImage} />
                    ) : (
                      <div className="album-card-art">{t.title[0]?.toUpperCase() ?? "?"}</div>
                    )}
                    <LikeDislikeButtons
                      liked={t.liked}
                      onToggleLike={() => handleTrackLike(t)}
                      onToggleDislike={() => handleTrackDislike(t)}
                      variant="overlay"
                      size={12}
                    />
                    <button className="album-card-menu-btn" onClick={(e) => { e.stopPropagation(); onTrackContextMenu(e, t, new Set()); }} title="More options">&#x22EF;</button>
                    <button className="album-card-play-btn" onClick={(e) => { e.stopPropagation(); onPlayTracks([t], 0); }} title="Play">
                      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
                    </button>
                    </div>
                    <div className="album-card-body">
                      <div className="album-card-title" title={t.title}>{t.title}</div>
                      <div className="album-card-info">
                        {t.artist_name && <>{t.artist_name} {"\u00B7"} </>}
                        {formatDuration(t.duration_secs)}
                      </div>
                    </div>
                  </div>
                ))}
                {results.tracks.length === 0 && (
                  <div className="empty">No tracks found.</div>
                )}
              </div>
            </div>
            {hasMore.tracks && (
              <div className="search-view-load-more">
                <button onClick={handleLoadMore} disabled={loadingMore.tracks}>
                  {loadingMore.tracks ? "Loading..." : "Load More"}
                </button>
              </div>
            )}
          </>
        )}

        {searched && activeTab === "albums" && (
          <div className={`sort-bar-wrapper${sortBarCollapsed ? " collapsed" : ""}`}>
            <div className="sort-bar">
              <div className="sort-bar-row">
                <span className="sort-bar-label">Sort:</span>
                <div className="sort-bar-group">
                  <SortButton label="Name" field="name" chain={albumSortChain} onClick={handleAlbumSortClick} />
                  <SortButton label="Artist" field="artist" chain={albumSortChain} onClick={handleAlbumSortClick} />
                  <SortButton label="Year" field="year" chain={albumSortChain} onClick={handleAlbumSortClick} />
                  <SortButton label="Tracks" field="tracks" chain={albumSortChain} onClick={handleAlbumSortClick} />
                  <SortButton label={"\u2665 Liked"} field="liked" chain={albumSortChain} onClick={handleAlbumSortClick} />
                  <SortButton label="Shuffle" field="random" chain={albumSortChain} onClick={handleAlbumSortClick} />
                  {albumSortChain.length >= 2 && (
                    <button className="sort-btn sort-btn-clear" onClick={() => setAlbumSortChain([])}>Clear</button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {searched && activeTab === "albums" && (
          <SearchAlbumResults
            albums={results.albums}
            viewMode={viewModes.albums}
            albumImages={albumImages}
            onAlbumClick={onAlbumClick}
            onToggleLike={onToggleAlbumLike}
            onContextMenu={onAlbumContextMenu}
            onFetchImage={onFetchAlbumImage}
            onPlayTracks={onPlayTracks}
            hasMore={hasMore.albums}
            loadingMore={loadingMore.albums}
            onLoadMore={handleLoadMore}
            onSort={(field: string) => handleAlbumSortClick(field)}
            sortField={albumSortChain[0]?.field ?? null}
            sortIndicator={(field: string) => { const d = chainDir(albumSortChain, field); return d ? (d === "asc" ? " ▲" : " ▼") : ""; }}
          />
        )}

        {searched && activeTab === "artists" && (
          <div className={`sort-bar-wrapper${sortBarCollapsed ? " collapsed" : ""}`}>
            <div className="sort-bar">
              <div className="sort-bar-row">
                <span className="sort-bar-label">Sort:</span>
                <div className="sort-bar-group">
                  <SortButton label="Name" field="name" chain={artistSortChain} onClick={handleArtistSortClick} />
                  <SortButton label="Tracks" field="tracks" chain={artistSortChain} onClick={handleArtistSortClick} />
                  <SortButton label={"\u2665 Liked"} field="liked" chain={artistSortChain} onClick={handleArtistSortClick} />
                  <SortButton label="Shuffle" field="random" chain={artistSortChain} onClick={handleArtistSortClick} />
                  {artistSortChain.length >= 2 && (
                    <button className="sort-btn sort-btn-clear" onClick={() => setArtistSortChain([])}>Clear</button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {searched && activeTab === "artists" && (
          <SearchArtistResults
            artists={results.artists}
            viewMode={viewModes.artists}
            artistImages={artistImages}
            onArtistClick={onArtistClick}
            onToggleLike={onToggleArtistLike}
            onContextMenu={onArtistContextMenu}
            onFetchImage={onFetchArtistImage}
            onPlayTracks={onPlayTracks}
            hasMore={hasMore.artists}
            loadingMore={loadingMore.artists}
            onLoadMore={handleLoadMore}
            onSort={(field: string) => handleArtistSortClick(field)}
            sortField={artistSortChain[0]?.field ?? null}
            sortIndicator={(field: string) => { const d = chainDir(artistSortChain, field); return d ? (d === "asc" ? " ▲" : " ▼") : ""; }}
          />
        )}

        {searched && activeTab === "tags" && (
          <div className={`sort-bar-wrapper${sortBarCollapsed ? " collapsed" : ""}`}>
            <div className="sort-bar">
              <div className="sort-bar-row">
                <span className="sort-bar-label">Sort:</span>
                <div className="sort-bar-group">
                  <SortButton label="Name" field="name" chain={tagSortChain} onClick={handleTagSortClick} />
                  <SortButton label="Tracks" field="tracks" chain={tagSortChain} onClick={handleTagSortClick} />
                  <SortButton label={"\u2665 Liked"} field="liked" chain={tagSortChain} onClick={handleTagSortClick} />
                  <SortButton label="Shuffle" field="random" chain={tagSortChain} onClick={handleTagSortClick} />
                  {tagSortChain.length >= 2 && (
                    <button className="sort-btn sort-btn-clear" onClick={() => setTagSortChain([])}>Clear</button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {searched && activeTab === "tags" && (
          <SearchTagResults
            tags={results.tags}
            viewMode={viewModes.tags}
            tagImages={tagImages}
            onTagClick={onTagClick}
            onToggleLike={onToggleTagLike}
            onFetchImage={onFetchTagImage}
            onPlayTracks={onPlayTracks}
            hasMore={hasMore.tags}
            loadingMore={loadingMore.tags}
            onLoadMore={handleLoadMore}
            onSort={(field: string) => handleTagSortClick(field)}
            sortField={tagSortChain[0]?.field ?? null}
            sortIndicator={(field: string) => { const d = chainDir(tagSortChain, field); return d ? (d === "asc" ? " ▲" : " ▼") : ""; }}
          />
        )}
      </div>
    </div>
  );
}

function SearchTagResults({
  tags, viewMode, tagImages, onTagClick, onToggleLike,
  onFetchImage, onPlayTracks, hasMore, loadingMore, onLoadMore,
  onSort, sortField, sortIndicator,
}: {
  tags: Tag[];
  viewMode: ViewMode;
  tagImages: Record<number, string | null>;
  onTagClick: (id: number) => void;
  onToggleLike: (id: number) => void;
  onFetchImage: (tag: { id: number }) => void;
  onPlayTracks: (tracks: Track[], index: number) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSort: (field: string) => void;
  sortField: string | null;
  sortIndicator: (field: string) => string;
}) {
  return (
    <>
      {viewMode === "basic" && (
        <div className="entity-table">
          <div className="entity-table-header">
            <span className="entity-table-like"></span>
            <span className={`entity-table-name sortable${sortField === "name" ? " sorted" : ""}`} onClick={() => onSort("name")}>Name{sortIndicator("name")}</span>
            <span className={`entity-table-count sortable${sortField === "tracks" ? " sorted" : ""}`} onClick={() => onSort("tracks")}>Tracks{sortIndicator("tracks")}</span>
          </div>
          {tags.map(t => (
            <div key={t.id} className="entity-table-row" onClick={() => onTagClick(t.id)}>
              <LikeDislikeButtons liked={t.liked} onToggleLike={() => onToggleLike(t.id)} variant="inline" size={12} />
              <span className="entity-table-name">{t.name}</span>
              <span className="entity-table-count">{t.track_count}</span>
            </div>
          ))}
          {tags.length === 0 && <div className="empty">No tags found.</div>}
        </div>
      )}

      {viewMode === "list" && (
        <div className="entity-list">
          {tags.map(t => (
            <div key={t.id} className="entity-list-item" onClick={() => onTagClick(t.id)}>
              <LikeDislikeButtons liked={t.liked} onToggleLike={() => onToggleLike(t.id)} variant="inline" size={12} />
              <TagCardArt tag={t} imagePath={tagImages[t.id]} onVisible={onFetchImage} className="entity-list-img" />
              <div className="entity-list-info">
                <span className="entity-list-name">{t.name}</span>
                <span className="entity-list-secondary">{t.track_count} tracks</span>
              </div>
            </div>
          ))}
          {tags.length === 0 && <div className="empty">No tags found.</div>}
        </div>
      )}

      {viewMode === "tiles" && (
        <div className="tiles-scroll">
          <div className="album-grid">
            {tags.map(t => (
              <div key={t.id} className="tag-card" onClick={() => onTagClick(t.id)}>
                <div className="album-card-art-wrapper">
                  <TagCardArt tag={t} imagePath={tagImages[t.id]} onVisible={onFetchImage} />
                  <LikeDislikeButtons liked={t.liked} onToggleLike={() => onToggleLike(t.id)} variant="overlay" size={12} />
                  <button className="album-card-play-btn" onClick={async e => { e.stopPropagation(); const tracks = await invoke<Track[]>("get_tracks", { opts: { tagId: t.id } }); if (tracks.length > 0) onPlayTracks(tracks, 0); }} title="Play">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
                  </button>
                </div>
                <div className="tag-card-body">
                  <div className="tag-card-name" title={t.name}>{t.name}</div>
                  <div className="tag-card-info">{t.track_count} tracks</div>
                </div>
              </div>
            ))}
            {tags.length === 0 && <div className="empty">No tags found.</div>}
          </div>
        </div>
      )}

      {hasMore && (
        <div className="search-view-load-more">
          <button onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading..." : "Load More"}
          </button>
        </div>
      )}
    </>
  );
}

function SearchAlbumResults({
  albums, viewMode, albumImages, onAlbumClick, onToggleLike,
  onContextMenu, onFetchImage, onPlayTracks, hasMore, loadingMore, onLoadMore,
  onSort, sortField, sortIndicator,
}: {
  albums: Album[];
  viewMode: ViewMode;
  albumImages: Record<number, string | null>;
  onAlbumClick: (id: number, artistId?: number | null) => void;
  onToggleLike: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, id: number) => void;
  onFetchImage: (album: Album) => void;
  onPlayTracks: (tracks: Track[], index: number) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSort: (field: string) => void;
  sortField: string | null;
  sortIndicator: (field: string) => string;
}) {
  return (
    <>
      {viewMode === "basic" && (
        <div className="entity-table">
          <div className="entity-table-header">
            <span className="entity-table-like"></span>
            <span className={`entity-table-name sortable${sortField === "name" ? " sorted" : ""}`} onClick={() => onSort("name")}>Name{sortIndicator("name")}</span>
            <span className={`entity-table-secondary sortable${sortField === "artist" ? " sorted" : ""}`} onClick={() => onSort("artist")}>Artist{sortIndicator("artist")}</span>
            <span className={`entity-table-year sortable${sortField === "year" ? " sorted" : ""}`} onClick={() => onSort("year")}>Year{sortIndicator("year")}</span>
            <span className={`entity-table-count sortable${sortField === "tracks" ? " sorted" : ""}`} onClick={() => onSort("tracks")}>Tracks{sortIndicator("tracks")}</span>
          </div>
          {albums.map(a => (
            <div key={a.id} className="entity-table-row" onClick={() => onAlbumClick(a.id, a.artist_id)} onContextMenu={e => onContextMenu(e, a.id)}>
              <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} variant="inline" size={12} />
              <span className="entity-table-name">{a.title}</span>
              <span className="entity-table-secondary">{a.artist_name ?? ""}</span>
              <span className="entity-table-year">{a.year ?? ""}</span>
              <span className="entity-table-count">{a.track_count}</span>
            </div>
          ))}
          {albums.length === 0 && <div className="empty">No albums found.</div>}
        </div>
      )}

      {viewMode === "list" && (
        <div className="entity-list">
          {albums.map(a => (
            <div key={a.id} className="entity-list-item" onClick={() => onAlbumClick(a.id, a.artist_id)} onContextMenu={e => onContextMenu(e, a.id)}>
              <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} variant="inline" size={12} />
              <AlbumCardArt album={a} imagePath={albumImages[a.id]} onVisible={onFetchImage} />
              <div className="entity-list-info">
                <span className="entity-list-name">{a.title}</span>
                <span className="entity-list-secondary">
                  {a.artist_name && <>{a.artist_name} {"\u00B7"} </>}
                  {a.year ? `${a.year} \u00B7 ` : ""}{a.track_count} tracks
                </span>
              </div>
            </div>
          ))}
          {albums.length === 0 && <div className="empty">No albums found.</div>}
        </div>
      )}

      {viewMode === "tiles" && (
        <div className="tiles-scroll">
          <div className="album-grid">
            {albums.map(a => (
              <div key={a.id} className="album-card" onClick={() => onAlbumClick(a.id, a.artist_id)} onContextMenu={e => onContextMenu(e, a.id)}>
                <div className="album-card-art-wrapper">
                  <AlbumCardArt album={a} imagePath={albumImages[a.id]} onVisible={onFetchImage} />
                  <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} variant="overlay" size={12} />
                  <button className="album-card-menu-btn" onClick={e => { e.stopPropagation(); onContextMenu(e, a.id); }} title="More options">&#x22EF;</button>
                  <button className="album-card-play-btn" onClick={async e => { e.stopPropagation(); const t = await invoke<Track[]>("get_tracks", { opts: { albumId: a.id } }); if (t.length > 0) onPlayTracks(t, 0); }} title="Play">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
                  </button>
                </div>
                <div className="album-card-body">
                  <div className="album-card-title" title={a.title}>{a.title}</div>
                  <div className="album-card-info">
                    {a.artist_name && a.year ? `${a.artist_name} - ${a.year}` : a.artist_name || (a.year ? String(a.year) : "")}
                  </div>
                </div>
              </div>
            ))}
            {albums.length === 0 && <div className="empty">No albums found.</div>}
          </div>
        </div>
      )}

      {hasMore && (
        <div className="search-view-load-more">
          <button onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading..." : "Load More"}
          </button>
        </div>
      )}
    </>
  );
}

function SearchArtistResults({
  artists, viewMode, artistImages, onArtistClick, onToggleLike,
  onContextMenu, onFetchImage, onPlayTracks, hasMore, loadingMore, onLoadMore,
  onSort, sortField, sortIndicator,
}: {
  artists: Artist[];
  viewMode: ViewMode;
  artistImages: Record<number, string | null>;
  onArtistClick: (id: number) => void;
  onToggleLike: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, id: number) => void;
  onFetchImage: (artist: Artist) => void;
  onPlayTracks: (tracks: Track[], index: number) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSort: (field: string) => void;
  sortField: string | null;
  sortIndicator: (field: string) => string;
}) {
  return (
    <>
      {viewMode === "basic" && (
        <div className="entity-table">
          <div className="entity-table-header">
            <span className="entity-table-like"></span>
            <span className={`entity-table-name sortable${sortField === "name" ? " sorted" : ""}`} onClick={() => onSort("name")}>Name{sortIndicator("name")}</span>
            <span className={`entity-table-count sortable${sortField === "tracks" ? " sorted" : ""}`} onClick={() => onSort("tracks")}>Tracks{sortIndicator("tracks")}</span>
          </div>
          {artists.map(a => (
            <div key={a.id} className="entity-table-row" onClick={() => onArtistClick(a.id)} onContextMenu={e => onContextMenu(e, a.id)}>
              <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} variant="inline" size={12} />
              <span className="entity-table-name">{a.name}</span>
              <span className="entity-table-count">{a.track_count}</span>
            </div>
          ))}
          {artists.length === 0 && <div className="empty">No artists found.</div>}
        </div>
      )}

      {viewMode === "list" && (
        <div className="entity-list">
          {artists.map(a => (
            <div key={a.id} className="entity-list-item" onClick={() => onArtistClick(a.id)} onContextMenu={e => onContextMenu(e, a.id)}>
              <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} variant="inline" size={12} />
              <ArtistCardArt artist={a} imagePath={artistImages[a.id]} onVisible={onFetchImage} className="entity-list-img circular" />
              <div className="entity-list-info">
                <span className="entity-list-name">{a.name}</span>
                <span className="entity-list-secondary">{a.track_count} tracks</span>
              </div>
            </div>
          ))}
          {artists.length === 0 && <div className="empty">No artists found.</div>}
        </div>
      )}

      {viewMode === "tiles" && (
        <div className="tiles-scroll">
          <div className="album-grid">
            {artists.map(a => (
              <div key={a.id} className="artist-card" onClick={() => onArtistClick(a.id)} onContextMenu={e => onContextMenu(e, a.id)}>
                <div className="album-card-art-wrapper">
                  <ArtistCardArt artist={a} imagePath={artistImages[a.id]} onVisible={onFetchImage} />
                  <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} variant="overlay" size={12} />
                  <button className="album-card-menu-btn" onClick={e => { e.stopPropagation(); onContextMenu(e, a.id); }} title="More options">&#x22EF;</button>
                  <button className="album-card-play-btn" onClick={async e => { e.stopPropagation(); const t = await invoke<Track[]>("get_tracks", { opts: { artistId: a.id } }); if (t.length > 0) onPlayTracks(t, 0); }} title="Play">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
                  </button>
                </div>
                <div className="artist-card-body">
                  <div className="artist-card-name" title={a.name}>{a.name}</div>
                </div>
              </div>
            ))}
            {artists.length === 0 && <div className="empty">No artists found.</div>}
          </div>
        </div>
      )}

      {hasMore && (
        <div className="search-view-load-more">
          <button onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading..." : "Load More"}
          </button>
        </div>
      )}
    </>
  );
}

function SortButton({ label, field, chain, onClick }: {
  label: string;
  field: string;
  chain: SortKey[];
  onClick: (field: string, e: React.MouseEvent) => void;
}) {
  const pos = chainPosition(chain, field);
  const dir = chainDir(chain, field);
  const arrow = dir === "asc" ? " ▲" : dir === "desc" ? " ▼" : "";
  return (
    <button
      className={`sort-btn${pos >= 0 ? " active" : ""}`}
      onClick={e => onClick(field, e)}
    >
      {label}{arrow}
      {chain.length > 1 && pos >= 0 && <span className="sort-btn-badge">{pos + 1}</span>}
    </button>
  );
}
