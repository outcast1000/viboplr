// Per-tab entity result renderers for SearchView (albums/artists/tags).
import type { Artist, Album, Tag, ViewMode } from "../../types";
import { ArtistCardArt } from "../ArtistCardArt";
import { AlbumCardArt } from "../AlbumCardArt";
import { TagCardArt } from "../TagCardArt";
import { LikeDislikeButtons } from "../LikeDislikeButtons";
import { LoadMoreSentinel } from "./searchShared";

function computeIdSelection(
  current: Set<number>,
  clickedIndex: number,
  ids: number[],
  lastIndex: number | null,
  meta: boolean,
  shift: boolean,
): Set<number> {
  if (shift) {
    const start = lastIndex ?? 0;
    const lo = Math.min(start, clickedIndex);
    const hi = Math.max(start, clickedIndex);
    const range = new Set(ids.slice(lo, hi + 1));
    if (meta) {
      const merged = new Set(current);
      for (const id of range) merged.add(id);
      return merged;
    }
    return range;
  }
  if (meta) {
    const next = new Set(current);
    if (next.has(ids[clickedIndex])) next.delete(ids[clickedIndex]);
    else next.add(ids[clickedIndex]);
    return next;
  }
  return new Set([ids[clickedIndex]]);
}

export function SearchTagResults({
  tags, viewMode, getTagImage, onTagClick, onToggleLike,
  onContextMenu, onMultiContextMenu, onPlayTag, hasMore, loadingMore, onLoadMore,
  onSort, sortField, sortIndicator, selectedIds, onSelectionChange, lastClickedRef, onDragStart,
}: {
  tags: Tag[];
  viewMode: ViewMode;
  getTagImage: (name: string) => string | null;
  onTagClick: (id: number) => void;
  onToggleLike: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, tag: Tag) => void;
  onMultiContextMenu: (e: React.MouseEvent, tagIds: number[]) => void;
  onPlayTag: (tagId: number) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSort: (field: string) => void;
  sortField: string | null;
  sortIndicator: (field: string) => string;
  selectedIds: Set<number>;
  onSelectionChange: (ids: Set<number>) => void;
  lastClickedRef: React.MutableRefObject<number | null>;
  onDragStart: (ids: number[]) => void;
}) {
  const ids = tags.map(t => t.id);
  function handleClick(e: React.MouseEvent, index: number) {
    if ((e.target as HTMLElement).closest('.col-like, .album-card-play-btn')) return;
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
      onSelectionChange(new Set());
      onTagClick(tags[index].id);
      return;
    }
    const sel = computeIdSelection(selectedIds, index, ids, lastClickedRef.current, e.metaKey || e.ctrlKey, e.shiftKey);
    onSelectionChange(sel);
    lastClickedRef.current = index;
  }
  function handleMouseDown(e: React.MouseEvent, id: number) {
    if (e.button !== 0 || !selectedIds.has(id) || selectedIds.size < 2) return;
    if ((e.target as HTMLElement).closest('.col-like, .album-card-menu-btn, .album-card-play-btn')) return;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    function onMove(ev: MouseEvent) { if (!dragging && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) >= 5) { dragging = true; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); onDragStart([...selectedIds]); } }
    function onUp() { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
  function handleCtxMenu(e: React.MouseEvent, tag: Tag) {
    e.preventDefault();
    if (selectedIds.size > 1 && selectedIds.has(tag.id)) {
      onMultiContextMenu(e, [...selectedIds]);
    } else {
      onContextMenu(e, tag);
    }
  }
  return (
    <>
      {viewMode === "basic" && (
        <div className="entity-table">
          <div className="entity-table-header">
            <span className="entity-table-like"></span>
            <span className={`entity-table-name sortable${sortField === "name" ? " sorted" : ""}`} onClick={() => onSort("name")}>Name{sortIndicator("name")}</span>
            <span className={`entity-table-count sortable${sortField === "tracks" ? " sorted" : ""}`} onClick={() => onSort("tracks")}>Tracks{sortIndicator("tracks")}</span>
          </div>
          {tags.map((t, i) => (
            <div key={t.id} className={`entity-table-row${selectedIds.has(t.id) ? " selected" : ""}`} onClick={e => handleClick(e, i)} onMouseDown={e => handleMouseDown(e, t.id)} onContextMenu={e => handleCtxMenu(e, t)}>
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
          {tags.map((t, i) => (
            <div key={t.id} className={`entity-list-item${selectedIds.has(t.id) ? " selected" : ""}`} onClick={e => handleClick(e, i)} onMouseDown={e => handleMouseDown(e, t.id)} onContextMenu={e => handleCtxMenu(e, t)}>
              <LikeDislikeButtons liked={t.liked} onToggleLike={() => onToggleLike(t.id)} variant="inline" size={12} />
              <TagCardArt tag={t} imagePath={getTagImage(t.name)} className="entity-list-img" />
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
            {tags.map((t, i) => (
              <div key={t.id} className={`tag-card${selectedIds.has(t.id) ? " selected" : ""}`} onClick={e => handleClick(e, i)} onMouseDown={e => handleMouseDown(e, t.id)} onContextMenu={e => handleCtxMenu(e, t)}>
                <div className="album-card-art-wrapper">
                  <TagCardArt tag={t} imagePath={getTagImage(t.name)} />
                  <LikeDislikeButtons liked={t.liked} onToggleLike={() => onToggleLike(t.id)} variant="overlay" size={12} />
                  <button className="album-card-menu-btn" onClick={e => { e.stopPropagation(); handleCtxMenu(e, t); }} title="More options">&#x22EF;</button>
                  <button className="album-card-play-btn" onClick={e => { e.stopPropagation(); onPlayTag(t.id); }} title="Play">
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

      <LoadMoreSentinel hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
    </>
  );
}

export function SearchAlbumResults({
  albums, viewMode, getAlbumImage, onAlbumClick, onToggleLike,
  onContextMenu, onMultiContextMenu, onPlayAlbum, hasMore, loadingMore, onLoadMore,
  onSort, sortField, sortIndicator, selectedIds, onSelectionChange, lastClickedRef, onDragStart,
}: {
  albums: Album[];
  viewMode: ViewMode;
  getAlbumImage: (title: string, artistName?: string | null) => string | null;
  onAlbumClick: (id: number, artistId?: number | null) => void;
  onToggleLike: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, id: number) => void;
  onMultiContextMenu: (e: React.MouseEvent, albumIds: number[]) => void;
  onPlayAlbum: (albumId: number) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSort: (field: string) => void;
  sortField: string | null;
  sortIndicator: (field: string) => string;
  selectedIds: Set<number>;
  onSelectionChange: (ids: Set<number>) => void;
  lastClickedRef: React.MutableRefObject<number | null>;
  onDragStart: (ids: number[]) => void;
}) {
  const ids = albums.map(a => a.id);
  function handleClick(e: React.MouseEvent, index: number) {
    if ((e.target as HTMLElement).closest('.col-like, .album-card-menu-btn, .album-card-play-btn')) return;
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
      onSelectionChange(new Set());
      const a = albums[index];
      onAlbumClick(a.id, a.artist_id);
      return;
    }
    const sel = computeIdSelection(selectedIds, index, ids, lastClickedRef.current, e.metaKey || e.ctrlKey, e.shiftKey);
    onSelectionChange(sel);
    lastClickedRef.current = index;
  }
  function handleMouseDown(e: React.MouseEvent, id: number) {
    if (e.button !== 0 || !selectedIds.has(id) || selectedIds.size < 2) return;
    if ((e.target as HTMLElement).closest('.col-like, .album-card-menu-btn, .album-card-play-btn')) return;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    function onMove(ev: MouseEvent) { if (!dragging && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) >= 5) { dragging = true; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); onDragStart([...selectedIds]); } }
    function onUp() { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
  function handleCtxMenu(e: React.MouseEvent, album: Album) {
    e.preventDefault();
    if (selectedIds.size > 1 && selectedIds.has(album.id)) {
      onMultiContextMenu(e, [...selectedIds]);
    } else {
      onContextMenu(e, album.id);
    }
  }
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
          {albums.map((a, i) => (
            <div key={a.id} className={`entity-table-row${selectedIds.has(a.id) ? " selected" : ""}`} onClick={e => handleClick(e, i)} onMouseDown={e => handleMouseDown(e, a.id)} onContextMenu={e => handleCtxMenu(e, a)}>
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
          {albums.map((a, i) => (
            <div key={a.id} className={`entity-list-item${selectedIds.has(a.id) ? " selected" : ""}`} onClick={e => handleClick(e, i)} onMouseDown={e => handleMouseDown(e, a.id)} onContextMenu={e => handleCtxMenu(e, a)}>
              <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} variant="inline" size={12} />
              <AlbumCardArt album={a} imagePath={getAlbumImage(a.title, a.artist_name)} />
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
            {albums.map((a, i) => (
              <div key={a.id} className={`album-card${selectedIds.has(a.id) ? " selected" : ""}`} onClick={e => handleClick(e, i)} onMouseDown={e => handleMouseDown(e, a.id)} onContextMenu={e => handleCtxMenu(e, a)}>
                <div className="album-card-art-wrapper">
                  <AlbumCardArt album={a} imagePath={getAlbumImage(a.title, a.artist_name)} />
                  <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} variant="overlay" size={12} />
                  <button className="album-card-menu-btn" onClick={e => { e.stopPropagation(); handleCtxMenu(e, a); }} title="More options">&#x22EF;</button>
                  <button className="album-card-play-btn" onClick={e => { e.stopPropagation(); onPlayAlbum(a.id); }} title="Play">
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

      <LoadMoreSentinel hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
    </>
  );
}

export function SearchArtistResults({
  artists, viewMode, getArtistImage, onArtistClick, onToggleLike,
  onContextMenu, onMultiContextMenu, onPlayArtist, hasMore, loadingMore, onLoadMore,
  onSort, sortField, sortIndicator, selectedIds, onSelectionChange, lastClickedRef, onDragStart,
}: {
  artists: Artist[];
  viewMode: ViewMode;
  getArtistImage: (name: string) => string | null;
  onArtistClick: (id: number) => void;
  onToggleLike: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, id: number) => void;
  onMultiContextMenu: (e: React.MouseEvent, artistIds: number[]) => void;
  onPlayArtist: (artistId: number) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSort: (field: string) => void;
  sortField: string | null;
  sortIndicator: (field: string) => string;
  selectedIds: Set<number>;
  onSelectionChange: (ids: Set<number>) => void;
  lastClickedRef: React.MutableRefObject<number | null>;
  onDragStart: (ids: number[]) => void;
}) {
  const ids = artists.map(a => a.id);
  function handleClick(e: React.MouseEvent, index: number) {
    if ((e.target as HTMLElement).closest('.col-like, .album-card-menu-btn, .album-card-play-btn')) return;
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
      onSelectionChange(new Set());
      onArtistClick(artists[index].id);
      return;
    }
    const sel = computeIdSelection(selectedIds, index, ids, lastClickedRef.current, e.metaKey || e.ctrlKey, e.shiftKey);
    onSelectionChange(sel);
    lastClickedRef.current = index;
  }
  function handleMouseDown(e: React.MouseEvent, id: number) {
    if (e.button !== 0 || !selectedIds.has(id) || selectedIds.size < 2) return;
    if ((e.target as HTMLElement).closest('.col-like, .album-card-menu-btn, .album-card-play-btn')) return;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    function onMove(ev: MouseEvent) { if (!dragging && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) >= 5) { dragging = true; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); onDragStart([...selectedIds]); } }
    function onUp() { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
  function handleCtxMenu(e: React.MouseEvent, artistId: number) {
    e.preventDefault();
    if (selectedIds.size > 1 && selectedIds.has(artistId)) {
      onMultiContextMenu(e, [...selectedIds]);
    } else {
      onContextMenu(e, artistId);
    }
  }
  return (
    <>
      {viewMode === "basic" && (
        <div className="entity-table">
          <div className="entity-table-header">
            <span className="entity-table-like"></span>
            <span className={`entity-table-name sortable${sortField === "name" ? " sorted" : ""}`} onClick={() => onSort("name")}>Name{sortIndicator("name")}</span>
            <span className={`entity-table-count sortable${sortField === "tracks" ? " sorted" : ""}`} onClick={() => onSort("tracks")}>Tracks{sortIndicator("tracks")}</span>
          </div>
          {artists.map((a, i) => (
            <div key={a.id} className={`entity-table-row${selectedIds.has(a.id) ? " selected" : ""}`} onClick={e => handleClick(e, i)} onMouseDown={e => handleMouseDown(e, a.id)} onContextMenu={e => handleCtxMenu(e, a.id)}>
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
          {artists.map((a, i) => (
            <div key={a.id} className={`entity-list-item${selectedIds.has(a.id) ? " selected" : ""}`} onClick={e => handleClick(e, i)} onMouseDown={e => handleMouseDown(e, a.id)} onContextMenu={e => handleCtxMenu(e, a.id)}>
              <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} variant="inline" size={12} />
              <ArtistCardArt artist={a} imagePath={getArtistImage(a.name)} className="entity-list-img circular" />
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
            {artists.map((a, i) => (
              <div key={a.id} className={`artist-card${selectedIds.has(a.id) ? " selected" : ""}`} onClick={e => handleClick(e, i)} onMouseDown={e => handleMouseDown(e, a.id)} onContextMenu={e => handleCtxMenu(e, a.id)}>
                <div className="album-card-art-wrapper">
                  <ArtistCardArt artist={a} imagePath={getArtistImage(a.name)} />
                  <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} variant="overlay" size={12} />
                  <button className="album-card-menu-btn" onClick={e => { e.stopPropagation(); handleCtxMenu(e, a.id); }} title="More options">&#x22EF;</button>
                  <button className="album-card-play-btn" onClick={e => { e.stopPropagation(); onPlayArtist(a.id); }} title="Play">
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

      <LoadMoreSentinel hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
    </>
  );
}
