import type { Artist, ArtistSortField, SortDir, ViewMode } from "../types";
import { ArtistCardArt } from "./ArtistCardArt";
import { ViewSearchBar } from "./ViewSearchBar";

interface ArtistListViewProps {
  artists: Artist[];
  highlightedIndex: number;
  viewMode: ViewMode;
  sortField: ArtistSortField | null;
  sortDir: SortDir;
  sortBarCollapsed: boolean;
  likedFirst: boolean;
  searchQuery: string;
  artistImages: Record<number, string | null>;
  onArtistClick: (id: number) => void;
  onToggleLike: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, id: number) => void;
  onSort: (field: ArtistSortField) => void;
  onSetLikedFirst: (fn: (v: boolean) => boolean) => void;
  onSearchChange: (q: string) => void;
  searchNav: { onArrowDown: () => void; onArrowUp: () => void; onEnter: () => void };
  onFetchImage: (artist: Artist) => void;
}

export function ArtistListView({
  artists,
  highlightedIndex,
  viewMode,
  sortField,
  sortDir,
  sortBarCollapsed,
  likedFirst,
  searchQuery,
  artistImages,
  onArtistClick,
  onToggleLike,
  onContextMenu,
  onSort,
  onSetLikedFirst,
  onSearchChange,
  searchNav,
  onFetchImage,
}: ArtistListViewProps) {
  return (
    <>
      <div className={`sort-bar-wrapper${sortBarCollapsed ? " collapsed" : ""}`}>
        <div className="sort-bar">
          <div className="sort-bar-row">
            <span className="sort-bar-label">Sort:</span>
            <div className="sort-bar-group">
              <button className={`sort-btn${sortField === "name" ? " active" : ""}`} onClick={() => onSort("name")}>
                Name{sortField === "name" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
              </button>
              <button className={`sort-btn${sortField === "tracks" ? " active" : ""}`} onClick={() => onSort("tracks")}>
                Tracks{sortField === "tracks" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
              </button>
              <button className={`sort-btn${sortField === "random" ? " active" : ""}`} onClick={() => onSort("random")}>
                Shuffle
              </button>
              <button
                className={`sort-btn liked-first-btn${likedFirst ? " active" : ""}`}
                onClick={() => onSetLikedFirst(v => !v)}
                title="Liked first"
              >{"\u2665"} Liked first</button>
            </div>
          </div>
        </div>
      </div>
      <ViewSearchBar
        query={searchQuery}
        onQueryChange={onSearchChange}
        placeholder="Search artists..."
        {...searchNav}
      />

      {/* Artists: Basic view */}
      {viewMode === "basic" && (
        <div className="entity-table">
          <div className="entity-table-header">
            <span className="entity-table-like"></span>
            <span className={`entity-table-name sortable${sortField === "name" ? " sorted" : ""}`} onClick={() => onSort("name")}>
              Name{sortField === "name" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
            </span>
            <span className={`entity-table-count sortable${sortField === "tracks" ? " sorted" : ""}`} onClick={() => onSort("tracks")}>
              Tracks{sortField === "tracks" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
            </span>
          </div>
          {artists.map((a, i) => (
            <div
              key={a.id}
              className={`entity-table-row${i === highlightedIndex ? " highlighted" : ""}`}
              onClick={() => onArtistClick(a.id)}
              onContextMenu={(e) => onContextMenu(e, a.id)}
            >
              <span
                className="entity-table-like"
                onClick={(e) => { e.stopPropagation(); onToggleLike(a.id); }}
              >{a.liked === 1 ? "\u2665" : "\u2661"}</span>
              <span className="entity-table-name">{a.name}</span>
              <span className="entity-table-count">{a.track_count}</span>
            </div>
          ))}
          {artists.length === 0 && (
            <div className="empty">{searchQuery.trim() ? `No artists matching "${searchQuery}"` : "No artists found. Add a folder or server to get started."}</div>
          )}
        </div>
      )}

      {/* Artists: List view */}
      {viewMode === "list" && (
        <div className="entity-list">
          {artists.map((a, i) => (
            <div
              key={a.id}
              className={`entity-list-item${i === highlightedIndex ? " highlighted" : ""}`}
              onClick={() => onArtistClick(a.id)}
              onContextMenu={(e) => onContextMenu(e, a.id)}
            >
              <span
                className="entity-list-like"
                onClick={(e) => { e.stopPropagation(); onToggleLike(a.id); }}
              >{a.liked === 1 ? "\u2665" : "\u2661"}</span>
              <ArtistCardArt artist={a} imagePath={artistImages[a.id]} onVisible={onFetchImage} className="entity-list-img circular" />
              <div className="entity-list-info">
                <span className="entity-list-name">{a.name}</span>
                <span className="entity-list-secondary">{a.track_count} tracks</span>
              </div>
            </div>
          ))}
          {artists.length === 0 && (
            <div className="empty">{searchQuery.trim() ? `No artists matching "${searchQuery}"` : "No artists found. Add a folder or server to get started."}</div>
          )}
        </div>
      )}

      {/* Artists: Tiles view */}
      {viewMode === "tiles" && (
        <div className="tiles-scroll">
          <div className="album-grid">
            {artists.map((a, i) => (
              <div
                key={a.id}
                className={`artist-card${i === highlightedIndex ? " highlighted" : ""}`}
                onClick={() => onArtistClick(a.id)}
                onContextMenu={(e) => onContextMenu(e, a.id)}
              >
                <ArtistCardArt artist={a} imagePath={artistImages[a.id]} onVisible={onFetchImage} />
                <div
                  className={`artist-card-like${a.liked === 1 ? " liked" : ""}`}
                  onClick={(e) => { e.stopPropagation(); onToggleLike(a.id); }}
                >{a.liked === 1 ? "\u2665" : "\u2661"}</div>
                <div className="artist-card-body">
                  <div className="artist-card-name" title={a.name}>{a.name}</div>
                </div>
              </div>
            ))}
            {artists.length === 0 && (
              <div className="empty">{searchQuery.trim() ? `No artists matching "${searchQuery}"` : "No artists found. Add a folder or server to get started."}</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
