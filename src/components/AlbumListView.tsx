import type { Album, AlbumSortField, SortDir, ViewMode } from "../types";
import { AlbumCardArt } from "./AlbumCardArt";
import { ViewSearchBar } from "./ViewSearchBar";

interface AlbumListViewProps {
  albums: Album[];
  highlightedIndex: number;
  viewMode: ViewMode;
  sortField: AlbumSortField | null;
  sortDir: SortDir;
  sortBarCollapsed: boolean;
  likedFirst: boolean;
  searchQuery: string;
  albumImages: Record<number, string | null>;
  onAlbumClick: (id: number) => void;
  onToggleLike: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, id: number) => void;
  onSort: (field: AlbumSortField) => void;
  onSetLikedFirst: (fn: (v: boolean) => boolean) => void;
  onSearchChange: (q: string) => void;
  searchNav: { onArrowDown: () => void; onArrowUp: () => void; onEnter: () => void };
  onFetchImage: (album: Album) => void;
}

export function AlbumListView({
  albums,
  highlightedIndex,
  viewMode,
  sortField,
  sortDir,
  sortBarCollapsed,
  likedFirst,
  searchQuery,
  albumImages,
  onAlbumClick,
  onToggleLike,
  onContextMenu,
  onSort,
  onSetLikedFirst,
  onSearchChange,
  searchNav,
  onFetchImage,
}: AlbumListViewProps) {
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
              <button className={`sort-btn${sortField === "artist" ? " active" : ""}`} onClick={() => onSort("artist")}>
                Artist{sortField === "artist" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
              </button>
              <button className={`sort-btn${sortField === "year" ? " active" : ""}`} onClick={() => onSort("year")}>
                Year{sortField === "year" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
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
        placeholder="Search albums..."
        {...searchNav}
      />

      {/* Albums: Basic view */}
      {viewMode === "basic" && (
        <div className="entity-table">
          <div className="entity-table-header">
            <span className="entity-table-like"></span>
            <span className={`entity-table-name sortable${sortField === "name" ? " sorted" : ""}`} onClick={() => onSort("name")}>
              Name{sortField === "name" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
            </span>
            <span className={`entity-table-secondary sortable${sortField === "artist" ? " sorted" : ""}`} onClick={() => onSort("artist")}>
              Artist{sortField === "artist" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
            </span>
            <span className={`entity-table-year sortable${sortField === "year" ? " sorted" : ""}`} onClick={() => onSort("year")}>
              Year{sortField === "year" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
            </span>
            <span className={`entity-table-count sortable${sortField === "tracks" ? " sorted" : ""}`} onClick={() => onSort("tracks")}>
              Tracks{sortField === "tracks" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
            </span>
          </div>
          {albums.map((a, i) => (
            <div
              key={a.id}
              className={`entity-table-row${i === highlightedIndex ? " highlighted" : ""}`}
              onClick={() => onAlbumClick(a.id)}
              onContextMenu={(e) => onContextMenu(e, a.id)}
            >
              <span
                className="entity-table-like"
                onClick={(e) => { e.stopPropagation(); onToggleLike(a.id); }}
              >{a.liked === 1 ? "\u2665" : "\u2661"}</span>
              <span className="entity-table-name">{a.title}</span>
              <span className="entity-table-secondary">{a.artist_name ?? ""}</span>
              <span className="entity-table-year">{a.year ?? ""}</span>
              <span className="entity-table-count">{a.track_count}</span>
            </div>
          ))}
          {albums.length === 0 && (
            <div className="empty">{searchQuery.trim() ? `No albums matching "${searchQuery}"` : "No albums found."}</div>
          )}
        </div>
      )}

      {/* Albums: List view */}
      {viewMode === "list" && (
        <div className="entity-list">
          {albums.map((a, i) => (
            <div
              key={a.id}
              className={`entity-list-item${i === highlightedIndex ? " highlighted" : ""}`}
              onClick={() => onAlbumClick(a.id)}
              onContextMenu={(e) => onContextMenu(e, a.id)}
            >
              <span
                className="entity-list-like"
                onClick={(e) => { e.stopPropagation(); onToggleLike(a.id); }}
              >{a.liked === 1 ? "\u2665" : "\u2661"}</span>
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
          {albums.length === 0 && (
            <div className="empty">{searchQuery.trim() ? `No albums matching "${searchQuery}"` : "No albums found."}</div>
          )}
        </div>
      )}

      {/* Albums: Tiles view */}
      {viewMode === "tiles" && (
        <div className="tiles-scroll">
          <div className="album-grid">
            {albums.map((a, i) => (
              <div key={a.id} className={`album-card${i === highlightedIndex ? " highlighted" : ""}`} onClick={() => onAlbumClick(a.id)} onContextMenu={(e) => onContextMenu(e, a.id)}>
                <AlbumCardArt album={a} imagePath={albumImages[a.id]} onVisible={onFetchImage} />
                <div
                  className={`album-card-like${a.liked === 1 ? " liked" : ""}`}
                  onClick={(e) => { e.stopPropagation(); onToggleLike(a.id); }}
                >{a.liked === 1 ? "\u2665" : "\u2661"}</div>
                <div className="album-card-body">
                  <div className="album-card-title" title={a.title}>{a.title}</div>
                  <div className="album-card-info">
                    {a.artist_name && <>{a.artist_name} {"\u00B7"} </>}
                    {a.year ? `${a.year} \u00B7 ` : ""}{a.track_count} tracks
                  </div>
                </div>
              </div>
            ))}
            {albums.length === 0 && (
              <div className="empty">{searchQuery.trim() ? `No albums matching "${searchQuery}"` : "No albums found."}</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
