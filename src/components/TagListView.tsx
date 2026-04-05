import type { Tag, TagSortField, SortDir, ViewMode } from "../types";
import { TagCardArt } from "./TagCardArt";
import { ViewSearchBar } from "./ViewSearchBar";

interface TagListViewProps {
  tags: Tag[];
  highlightedIndex: number;
  viewMode: ViewMode;
  sortField: TagSortField | null;
  sortDir: SortDir;
  sortBarCollapsed: boolean;
  likedFirst: boolean;
  searchQuery: string;
  tagImages: Record<number, string | null>;
  onTagClick: (id: number) => void;
  onToggleLike: (id: number) => void;
  onSort: (field: TagSortField) => void;
  onSetLikedFirst: (fn: (v: boolean) => boolean) => void;
  onSearchChange: (q: string) => void;
  searchNav: { onArrowDown: () => void; onArrowUp: () => void; onEnter: () => void };
  onFetchImage: (tag: { id: number }) => void;
}

export function TagListView({
  tags,
  highlightedIndex,
  viewMode,
  sortField,
  sortDir,
  sortBarCollapsed,
  likedFirst,
  searchQuery,
  tagImages,
  onTagClick,
  onToggleLike,
  onSort,
  onSetLikedFirst,
  onSearchChange,
  searchNav,
  onFetchImage,
}: TagListViewProps) {
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
        placeholder="Search tags..."
        {...searchNav}
      />

      {/* Tags: Basic view */}
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
          {tags.map((t, i) => (
            <div
              key={t.id}
              className={`entity-table-row${i === highlightedIndex ? " highlighted" : ""}`}
              onClick={() => onTagClick(t.id)}
            >
              <span
                className="entity-table-like"
                onClick={(e) => { e.stopPropagation(); onToggleLike(t.id); }}
              >{t.liked === 1 ? "\u2665" : "\u2661"}</span>
              <span className="entity-table-name">{t.name}</span>
              <span className="entity-table-count">{t.track_count}</span>
            </div>
          ))}
          {tags.length === 0 && (
            <div className="empty">{searchQuery.trim() ? `No tags matching "${searchQuery}"` : "No tags found. Add a folder or server to get started."}</div>
          )}
        </div>
      )}

      {/* Tags: List view */}
      {viewMode === "list" && (
        <div className="entity-list">
          {tags.map((t, i) => (
            <div
              key={t.id}
              className={`entity-list-item${i === highlightedIndex ? " highlighted" : ""}`}
              onClick={() => onTagClick(t.id)}
            >
              <span
                className="entity-list-like"
                onClick={(e) => { e.stopPropagation(); onToggleLike(t.id); }}
              >{t.liked === 1 ? "\u2665" : "\u2661"}</span>
              <TagCardArt tag={t} imagePath={tagImages[t.id]} onVisible={onFetchImage} className="entity-list-img" />
              <div className="entity-list-info">
                <span className="entity-list-name">{t.name}</span>
                <span className="entity-list-secondary">{t.track_count} tracks</span>
              </div>
            </div>
          ))}
          {tags.length === 0 && (
            <div className="empty">{searchQuery.trim() ? `No tags matching "${searchQuery}"` : "No tags found. Add a folder or server to get started."}</div>
          )}
        </div>
      )}

      {/* Tags: Tiles view */}
      {viewMode === "tiles" && (
        <div className="tiles-scroll">
          <div className="album-grid">
            {tags.map((t, i) => (
              <div
                key={t.id}
                className={`tag-card${i === highlightedIndex ? " highlighted" : ""}`}
                onClick={() => onTagClick(t.id)}
              >
                <TagCardArt tag={t} imagePath={tagImages[t.id]} onVisible={onFetchImage} />
                <div
                  className={`artist-card-like${t.liked === 1 ? " liked" : ""}`}
                  onClick={(e) => { e.stopPropagation(); onToggleLike(t.id); }}
                >{t.liked === 1 ? "\u2665" : "\u2661"}</div>
                <div className="tag-card-body">
                  <div className="tag-card-name" title={t.name}>{t.name}</div>
                  <div className="tag-card-info">{t.track_count} tracks</div>
                </div>
              </div>
            ))}
            {tags.length === 0 && (
              <div className="empty">{searchQuery.trim() ? `No tags matching "${searchQuery}"` : "No tags found. Add a folder or server to get started."}</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
