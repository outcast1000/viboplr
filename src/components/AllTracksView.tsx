import type { Track, Album, SortField, ColumnConfig } from "../types";
import { formatDuration } from "../utils";
import { TrackList } from "./TrackList";
import { ViewSearchBar } from "./ViewSearchBar";
import { AlbumCardArt } from "./AlbumCardArt";

interface AllTracksViewProps {
  sortedTracks: Track[];
  currentTrack: Track | null;
  playing: boolean;
  highlightedIndex: number;
  sortField: SortField | null;
  trackListRef: React.RefObject<HTMLDivElement | null>;
  columns: ColumnConfig[];
  trackViewMode: "basic" | "list" | "tiles";
  sortBarCollapsed: boolean;
  trackLikedFirst: boolean;
  mediaTypeFilter: "all" | "audio" | "video";
  filterYoutubeOnly: boolean;
  searchQuery: string;
  searchIncludeLyrics: boolean;
  albumImages: Record<number, string | null>;
  hasMore: boolean;
  loadingMore: boolean;
  onColumnsChange: (cols: ColumnConfig[]) => void;
  onDoubleClick: (tracks: Track[], index: number) => void;
  onContextMenu: (e: React.MouseEvent, track: Track, selectedIds: Set<number>) => void;
  onArtistClick: (artistId: number) => void;
  onAlbumClick: (albumId: number, artistId?: number | null) => void;
  onSort: (field: SortField) => void;
  sortIndicator: (field: SortField) => string;
  onToggleLike: (track: Track) => void;
  onToggleDislike: (track: Track) => void;
  onTrackDragStart: (dragTracks: Track[]) => void;
  onSearchChange: (query: string) => void;
  searchNav: {
    onArrowDown: () => void;
    onArrowUp: () => void;
    onEnter: () => void;
  };
  onFetchAlbumImage: (album: Album) => void;
  onLoadMore: () => void;
  onSetTrackLikedFirst: (value: boolean | ((prev: boolean) => boolean)) => void;
  onSetMediaTypeFilter: (filter: "all" | "audio" | "video") => void;
  onSetFilterYoutubeOnly: (value: boolean | ((prev: boolean) => boolean)) => void;
  onSetSearchIncludeLyrics: (value: boolean | ((prev: boolean) => boolean)) => void;
}

export function AllTracksView({
  sortedTracks,
  currentTrack,
  playing,
  highlightedIndex,
  sortField,
  trackListRef,
  columns,
  trackViewMode,
  sortBarCollapsed,
  trackLikedFirst,
  mediaTypeFilter,
  filterYoutubeOnly,
  searchQuery,
  searchIncludeLyrics,
  albumImages,
  hasMore,
  loadingMore,
  onColumnsChange,
  onDoubleClick,
  onContextMenu,
  onArtistClick,
  onAlbumClick,
  onSort,
  sortIndicator,
  onToggleLike,
  onToggleDislike,
  onTrackDragStart,
  onSearchChange,
  searchNav,
  onFetchAlbumImage,
  onLoadMore,
  onSetTrackLikedFirst,
  onSetMediaTypeFilter,
  onSetFilterYoutubeOnly,
  onSetSearchIncludeLyrics,
}: AllTracksViewProps) {
  return (
    <>
      <div className={`sort-bar-wrapper${sortBarCollapsed ? " collapsed" : ""}`}>
        <div className="sort-bar">
          <div className="sort-bar-row">
            <span className="sort-bar-label">Sort:</span>
            <div className="sort-bar-group">
              <button className={`sort-btn${sortField === "title" ? " active" : ""}`} onClick={() => onSort("title")}>
                Title{sortIndicator("title")}
              </button>
              <button className={`sort-btn${sortField === "artist" ? " active" : ""}`} onClick={() => onSort("artist")}>
                Artist{sortIndicator("artist")}
              </button>
              <button className={`sort-btn${sortField === "album" ? " active" : ""}`} onClick={() => onSort("album")}>
                Album{sortIndicator("album")}
              </button>
              <button className={`sort-btn${sortField === "year" ? " active" : ""}`} onClick={() => onSort("year")}>
                Year{sortIndicator("year")}
              </button>
              <button className={`sort-btn${sortField === "duration" ? " active" : ""}`} onClick={() => onSort("duration")}>
                Duration{sortIndicator("duration")}
              </button>
              <button className={`sort-btn${sortField === "added" ? " active" : ""}`} onClick={() => onSort("added")}>
                Added{sortIndicator("added")}
              </button>
              <button className={`sort-btn${sortField === "modified" ? " active" : ""}`} onClick={() => onSort("modified")}>
                Modified{sortIndicator("modified")}
              </button>
              <button className={`sort-btn${sortField === "random" ? " active" : ""}`} onClick={() => onSort("random")}>
                Shuffle
              </button>
              <button
                className={`sort-btn liked-first-btn${trackLikedFirst ? " active" : ""}`}
                onClick={() => onSetTrackLikedFirst(v => !v)}
                title="Liked first"
              >{"\u2665"} Liked first</button>
            </div>
          </div>
          <div className="sort-bar-row">
            <span className="sort-bar-label">Filter:</span>
            <div className="sort-bar-group sort-bar-group-filter">
              <button className={`sort-btn${mediaTypeFilter === "all" ? " active" : ""}`} onClick={() => onSetMediaTypeFilter("all")}>
                All
              </button>
              <button className={`sort-btn${mediaTypeFilter === "audio" ? " active" : ""}`} onClick={() => onSetMediaTypeFilter("audio")}>
                Audio
              </button>
              <button className={`sort-btn${mediaTypeFilter === "video" ? " active" : ""}`} onClick={() => onSetMediaTypeFilter("video")}>
                Video
              </button>
              <button className={`sort-btn${filterYoutubeOnly ? " active" : ""}`} onClick={() => onSetFilterYoutubeOnly(v => !v)}>
                YouTube
              </button>
            </div>
          </div>
        </div>
      </div>
      <ViewSearchBar
        query={searchQuery}
        onQueryChange={onSearchChange}
        placeholder="Search tracks..."
        {...searchNav}
      >
        <button
          className={`search-lyrics-toggle${searchIncludeLyrics ? " active" : ""}`}
          onClick={() => onSetSearchIncludeLyrics(v => !v)}
          title={searchIncludeLyrics ? "Lyrics included in search" : "Lyrics excluded from search"}
        >
          Lyrics
        </button>
      </ViewSearchBar>

      {/* Tracks: Basic view */}
      {trackViewMode === "basic" && (
        <TrackList
          tracks={sortedTracks}
          currentTrack={currentTrack}
          playing={playing}
          highlightedIndex={highlightedIndex}
          sortField={sortField}
          trackListRef={trackListRef}
          columns={columns}
          onColumnsChange={onColumnsChange}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onArtistClick={onArtistClick}
          onAlbumClick={onAlbumClick}
          onSort={onSort}
          sortIndicator={sortIndicator}
          onToggleLike={onToggleLike}
            onToggleDislike={onToggleDislike}
          onTrackDragStart={onTrackDragStart}
          emptyMessage="No tracks found. Add a folder or server to start building your library."
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={onLoadMore}
        />
      )}

      {/* Tracks: List view */}
      {trackViewMode === "list" && (
        <div className="entity-list">
          {sortedTracks.map((t, i) => (
            <div
              key={t.id}
              className={`entity-list-item${currentTrack?.id === t.id ? " playing" : ""}${i === highlightedIndex ? " highlighted" : ""}`}
              onDoubleClick={() => onDoubleClick([t], 0)}
              onContextMenu={(e) => onContextMenu(e, t, new Set())}
            >
              <span className="entity-list-like-group">
                <span
                  className={`entity-list-like${t.liked === 1 ? " active" : ""}`}
                  onClick={(e) => { e.stopPropagation(); onToggleLike(t); }}
                >{t.liked === 1 ? "\u2665" : "\u2661"}</span>
                <span
                  className={`entity-list-dislike${t.liked === -1 ? " active" : ""}`}
                  onClick={(e) => { e.stopPropagation(); onToggleDislike(t); }}
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
          {sortedTracks.length === 0 && (
            <div className="empty">No tracks found. Add a folder or server to start building your library.</div>
          )}
        </div>
      )}

      {/* Tracks: Tiles view */}
      {trackViewMode === "tiles" && (
        <div className="tiles-scroll">
          <div className="album-grid">
            {sortedTracks.map((t, i) => (
              <div
                key={t.id}
                className={`album-card${currentTrack?.id === t.id ? " playing" : ""}${i === highlightedIndex ? " highlighted" : ""}`}
                onDoubleClick={() => onDoubleClick([t], 0)}
                onContextMenu={(e) => onContextMenu(e, t, new Set())}
              >
                {t.album_id ? (
                  <AlbumCardArt album={{ id: t.album_id, title: t.album_title ?? "", artist_name: t.artist_name } as Album} imagePath={albumImages[t.album_id]} onVisible={onFetchAlbumImage} />
                ) : (
                  <div className="album-card-art">{t.title[0]?.toUpperCase() ?? "?"}</div>
                )}
                <div className="album-card-like-group">
                  <div
                    className={`album-card-like${t.liked === 1 ? " liked" : ""}`}
                    onClick={(e) => { e.stopPropagation(); onToggleLike(t); }}
                  >{t.liked === 1 ? "\u2665" : "\u2661"}</div>
                  <div
                    className={`album-card-dislike${t.liked === -1 ? " disliked" : ""}`}
                    onClick={(e) => { e.stopPropagation(); onToggleDislike(t); }}
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
            {sortedTracks.length === 0 && (
              <div className="empty">No tracks found. Add a folder or server to start building your library.</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
