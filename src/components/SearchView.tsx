import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, Artist, Album, ViewMode } from "../types";
import { formatDuration } from "../utils";
import { TrackList } from "./TrackList";
import { ArtistCardArt } from "./ArtistCardArt";
import { AlbumCardArt } from "./AlbumCardArt";
import { ViewModeToggle } from "./ViewModeToggle";

type SearchTab = "tracks" | "albums" | "artists";

interface SearchEntityResult {
  tracks: Track[] | null;
  albums: Album[] | null;
  artists: Artist[] | null;
  total: number;
}

interface SearchViewModes {
  tracks: ViewMode;
  albums: ViewMode;
  artists: ViewMode;
}

interface SearchViewProps {
  initialQuery: string | null;
  initialQueryKey: number;
  currentTrack: Track | null;
  playing: boolean;
  viewModes: SearchViewModes;
  onViewModesChange: (modes: SearchViewModes) => void;
  artistImages: Record<number, string | null>;
  albumImages: Record<number, string | null>;
  onPlayTracks: (tracks: Track[], index: number) => void;
  onArtistClick: (id: number) => void;
  onAlbumClick: (id: number, artistId?: number | null) => void;
  onTrackContextMenu: (e: React.MouseEvent, track: Track, selectedIds: Set<number>) => void;
  onArtistContextMenu: (e: React.MouseEvent, id: number) => void;
  onAlbumContextMenu: (e: React.MouseEvent, id: number) => void;
  onToggleLike: (track: Track) => void;
  onToggleDislike: (track: Track) => void;
  onToggleArtistLike: (id: number) => void;
  onToggleAlbumLike: (id: number) => void;
  onTrackDragStart: (tracks: Track[]) => void;
  onFetchArtistImage: (artist: Artist) => void;
  onFetchAlbumImage: (album: Album) => void;
  columns: import("../types").ColumnConfig[];
  onColumnsChange: (columns: import("../types").ColumnConfig[]) => void;
  sortField: import("../types").SortField | null;
  onSort: (field: import("../types").SortField) => void;
  sortIndicator: (field: import("../types").SortField) => string;
}

const TRACK_PAGE_SIZE = 50;
const ENTITY_PAGE_SIZE = 40;

export function SearchView({
  initialQuery,
  initialQueryKey,
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
  onFetchArtistImage,
  onFetchAlbumImage,
  columns,
  onColumnsChange,
  sortField,
  onSort,
  sortIndicator,
}: SearchViewProps) {
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<SearchTab>("tracks");
  const [results, setResults] = useState<{ tracks: Track[]; albums: Album[]; artists: Artist[] }>({ tracks: [], albums: [], artists: [] });
  const [counts, setCounts] = useState({ tracks: 0, albums: 0, artists: 0 });
  const [hasMore, setHasMore] = useState({ tracks: false, albums: false, artists: false });
  const [loadingMore, setLoadingMore] = useState({ tracks: false, albums: false, artists: false });
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const trackListRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const queryRef = useRef("");

  useEffect(() => {
    inputRef.current?.focus();
    doSearch("");
  }, []);

  useEffect(() => {
    if (initialQuery) {
      setQuery(initialQuery);
      queryRef.current = initialQuery;
      doSearch(initialQuery);
    }
  }, [initialQueryKey]);

  const doSearch = useCallback(async (q: string) => {
    setSearched(true);

    const [trackRes, albumRes, artistRes] = await Promise.all([
      invoke<SearchEntityResult>("search_entity", { query: q, entity: "tracks", limit: TRACK_PAGE_SIZE, offset: 0 }),
      invoke<SearchEntityResult>("search_entity", { query: q, entity: "albums", limit: ENTITY_PAGE_SIZE, offset: 0 }),
      invoke<SearchEntityResult>("search_entity", { query: q, entity: "artists", limit: ENTITY_PAGE_SIZE, offset: 0 }),
    ]);

    if (queryRef.current !== q) return;

    const tracks = trackRes.tracks ?? [];
    const albums = albumRes.albums ?? [];
    const artists = artistRes.artists ?? [];

    setResults({ tracks, albums, artists });
    setCounts({ tracks: trackRes.total, albums: albumRes.total, artists: artistRes.total });
    setHasMore({
      tracks: tracks.length < trackRes.total,
      albums: albums.length < albumRes.total,
      artists: artists.length < artistRes.total,
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
      const res = await invoke<SearchEntityResult>("search_entity", {
        query: queryRef.current,
        entity: tab,
        limit: pageSize,
        offset: currentCount,
      });

      const newItems = tab === "tracks" ? (res.tracks ?? []) : tab === "albums" ? (res.albums ?? []) : (res.artists ?? []);
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

  const handleTrackLike = useCallback((track: Track) => {
    const newLiked = track.liked === 1 ? 0 : 1;
    setResults(prev => ({ ...prev, tracks: prev.tracks.map(t => t.id === track.id ? { ...t, liked: newLiked } : t) }));
    onToggleLike(track);
  }, [onToggleLike]);

  const handleTrackDislike = useCallback((track: Track) => {
    const newLiked = track.liked === -1 ? 0 : -1;
    setResults(prev => ({ ...prev, tracks: prev.tracks.map(t => t.id === track.id ? { ...t, liked: newLiked } : t) }));
    onToggleDislike(track);
  }, [onToggleDislike]);

  const tabs: { id: SearchTab; label: string; count: number }[] = [
    { id: "tracks", label: "Tracks", count: counts.tracks },
    { id: "albums", label: "Albums", count: counts.albums },
    { id: "artists", label: "Artists", count: counts.artists },
  ];

  return (
    <div className="search-view">
      <div className="search-view-input-wrapper">
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
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
          <button className="search-view-clear" onClick={handleClear} title="Clear">&times;</button>
        )}
      </div>

      {searched && (
        <div className="search-view-tabs">
          <div className="search-view-tab-list">
            {tabs.map(tab => (
              <button
                key={tab.id}
                className={`search-view-tab ${activeTab === tab.id ? "active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
                {tab.count > 0 && <span className="search-view-tab-count">{tab.count}</span>}
              </button>
            ))}
          </div>
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

        {searched && activeTab === "tracks" && viewModes.tracks === "basic" && (
          <TrackList
            tracks={results.tracks}
            currentTrack={currentTrack}
            playing={playing}
            highlightedIndex={-1}
            sortField={sortField}
            trackListRef={trackListRef}
            columns={columns}
            onColumnsChange={onColumnsChange}
            onDoubleClick={onPlayTracks}
            onContextMenu={onTrackContextMenu}
            onArtistClick={onArtistClick}
            onAlbumClick={onAlbumClick}
            onSort={onSort}
            sortIndicator={sortIndicator}
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
                  key={t.id}
                  className={`entity-list-item${currentTrack?.id === t.id ? " playing" : ""}`}
                  onDoubleClick={() => onPlayTracks([t], 0)}
                  onContextMenu={(e) => onTrackContextMenu(e, t, new Set())}
                >
                  <span className="entity-list-like-group">
                    <span
                      className={`entity-list-like${t.liked === 1 ? " active" : ""}`}
                      onClick={(e) => { e.stopPropagation(); handleTrackLike(t); }}
                    >{t.liked === 1 ? "\u2665" : "\u2661"}</span>
                    <span
                      className={`entity-list-dislike${t.liked === -1 ? " active" : ""}`}
                      onClick={(e) => { e.stopPropagation(); handleTrackDislike(t); }}
                    >{t.liked === -1 ? "\u2716" : "\u2298"}</span>
                  </span>
                  {t.album_id ? (
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
                    key={t.id}
                    className={`album-card${currentTrack?.id === t.id ? " playing" : ""}`}
                    onDoubleClick={() => onPlayTracks([t], 0)}
                    onContextMenu={(e) => onTrackContextMenu(e, t, new Set())}
                  >
                    {t.album_id ? (
                      <AlbumCardArt album={{ id: t.album_id, title: t.album_title ?? "", artist_name: t.artist_name } as Album} imagePath={albumImages[t.album_id]} onVisible={onFetchAlbumImage} />
                    ) : (
                      <div className="album-card-art">{t.title[0]?.toUpperCase() ?? "?"}</div>
                    )}
                    <div className="album-card-like-group">
                      <div
                        className={`album-card-like${t.liked === 1 ? " liked" : ""}`}
                        onClick={(e) => { e.stopPropagation(); handleTrackLike(t); }}
                      >{t.liked === 1 ? "\u2665" : "\u2661"}</div>
                      <div
                        className={`album-card-dislike${t.liked === -1 ? " disliked" : ""}`}
                        onClick={(e) => { e.stopPropagation(); handleTrackDislike(t); }}
                      >{t.liked === -1 ? "\u2716" : "\u2298"}</div>
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
          <SearchAlbumResults
            albums={results.albums}
            viewMode={viewModes.albums}
            albumImages={albumImages}
            onAlbumClick={onAlbumClick}
            onToggleLike={onToggleAlbumLike}
            onContextMenu={onAlbumContextMenu}
            onFetchImage={onFetchAlbumImage}
            hasMore={hasMore.albums}
            loadingMore={loadingMore.albums}
            onLoadMore={handleLoadMore}
          />
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
            hasMore={hasMore.artists}
            loadingMore={loadingMore.artists}
            onLoadMore={handleLoadMore}
          />
        )}
      </div>
    </div>
  );
}

function SearchAlbumResults({
  albums, viewMode, albumImages, onAlbumClick, onToggleLike,
  onContextMenu, onFetchImage, hasMore, loadingMore, onLoadMore,
}: {
  albums: Album[];
  viewMode: ViewMode;
  albumImages: Record<number, string | null>;
  onAlbumClick: (id: number, artistId?: number | null) => void;
  onToggleLike: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, id: number) => void;
  onFetchImage: (album: Album) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <>
      {viewMode === "basic" && (
        <div className="entity-table">
          <div className="entity-table-header">
            <span className="entity-table-like"></span>
            <span className="entity-table-name">Name</span>
            <span className="entity-table-secondary">Artist</span>
            <span className="entity-table-year">Year</span>
            <span className="entity-table-count">Tracks</span>
          </div>
          {albums.map(a => (
            <div key={a.id} className="entity-table-row" onClick={() => onAlbumClick(a.id, a.artist_id)} onContextMenu={e => onContextMenu(e, a.id)}>
              <span className="entity-table-like" onClick={e => { e.stopPropagation(); onToggleLike(a.id); }}>{a.liked === 1 ? "\u2665" : "\u2661"}</span>
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
              <span className="entity-list-like" onClick={e => { e.stopPropagation(); onToggleLike(a.id); }}>{a.liked === 1 ? "\u2665" : "\u2661"}</span>
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
                <AlbumCardArt album={a} imagePath={albumImages[a.id]} onVisible={onFetchImage} />
                <div className={`album-card-like${a.liked === 1 ? " liked" : ""}`} onClick={e => { e.stopPropagation(); onToggleLike(a.id); }}>{a.liked === 1 ? "\u2665" : "\u2661"}</div>
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
  onContextMenu, onFetchImage, hasMore, loadingMore, onLoadMore,
}: {
  artists: Artist[];
  viewMode: ViewMode;
  artistImages: Record<number, string | null>;
  onArtistClick: (id: number) => void;
  onToggleLike: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, id: number) => void;
  onFetchImage: (artist: Artist) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <>
      {viewMode === "basic" && (
        <div className="entity-table">
          <div className="entity-table-header">
            <span className="entity-table-like"></span>
            <span className="entity-table-name">Name</span>
            <span className="entity-table-count">Tracks</span>
          </div>
          {artists.map(a => (
            <div key={a.id} className="entity-table-row" onClick={() => onArtistClick(a.id)} onContextMenu={e => onContextMenu(e, a.id)}>
              <span className="entity-table-like" onClick={e => { e.stopPropagation(); onToggleLike(a.id); }}>{a.liked === 1 ? "\u2665" : "\u2661"}</span>
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
              <span className="entity-list-like" onClick={e => { e.stopPropagation(); onToggleLike(a.id); }}>{a.liked === 1 ? "\u2665" : "\u2661"}</span>
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
                <ArtistCardArt artist={a} imagePath={artistImages[a.id]} onVisible={onFetchImage} />
                <div className={`artist-card-like${a.liked === 1 ? " liked" : ""}`} onClick={e => { e.stopPropagation(); onToggleLike(a.id); }}>{a.liked === 1 ? "\u2665" : "\u2661"}</div>
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
