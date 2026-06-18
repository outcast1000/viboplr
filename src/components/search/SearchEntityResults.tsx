// Per-tab entity result renderers for SearchView (albums/artists/tags).
import type { Artist, Album, Tag, ViewMode } from "../../types";
import { ArtistCardArt } from "../ArtistCardArt";
import { AlbumCardArt } from "../AlbumCardArt";
import { TagCardArt } from "../TagCardArt";
import { LikeDislikeButtons } from "../LikeDislikeButtons";
import { LoadMoreSentinel } from "./searchShared";

/** Info (Details) glyph shared by the row + tile overlay buttons. */
const DETAILS_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
);

/** Hover-reveal Play/Enqueue/Details overlay shared by the album/artist/tag table + list rows. */
function EntityRowActions({ onPlay, onEnqueue, onDetails }: { onPlay: () => void; onEnqueue: () => void; onDetails: () => void }) {
  return (
    <span className="row-hover-actions">
      <button type="button" className="row-hover-action row-hover-action--play" title="Play" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onPlay(); }}>
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
      </button>
      <button type="button" className="row-hover-action" title="Enqueue" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onEnqueue(); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button type="button" className="row-hover-action" title="Details" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDetails(); }}>
        {DETAILS_ICON}
      </button>
    </span>
  );
}

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
  tags, viewMode, getTagImage, onTagClick, onToggleLike, onToggleDislike,
  onContextMenu, onMultiContextMenu, onPlayTag, onEnqueueTag, hasMore, loadingMore, onLoadMore,
  onSort, sortField, sortIndicator, selectedIds, onSelectionChange, lastClickedRef, onDragStart,
}: {
  tags: Tag[];
  viewMode: ViewMode;
  getTagImage: (name: string) => string | null;
  onTagClick: (id: number) => void;
  onToggleLike: (id: number) => void;
  onToggleDislike: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, tag: Tag) => void;
  onMultiContextMenu: (e: React.MouseEvent, tagIds: number[]) => void;
  onPlayTag: (tagId: number) => void;
  onEnqueueTag: (tagId: number) => void;
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
    if ((e.target as HTMLElement).closest('.col-like, .album-card-menu-btn, .album-card-play-btn, .entity-list-play, .entity-list-enqueue, .entity-table-action, .row-hover-action')) return;
    const sel = computeIdSelection(selectedIds, index, ids, lastClickedRef.current, e.metaKey || e.ctrlKey, e.shiftKey);
    onSelectionChange(sel);
    lastClickedRef.current = index;
  }
  function handleMouseDown(e: React.MouseEvent, id: number) {
    if (e.button !== 0 || !selectedIds.has(id) || selectedIds.size < 2) return;
    if ((e.target as HTMLElement).closest('.col-like, .album-card-menu-btn, .album-card-play-btn, .entity-list-play, .entity-list-enqueue, .entity-table-action, .row-hover-action')) return;
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
              <LikeDislikeButtons liked={t.liked} onToggleLike={() => onToggleLike(t.id)} onToggleDislike={() => onToggleDislike(t.id)} variant="inline" size={12} />
              <span className="entity-table-name">
                <span className="entity-table-name-main">{t.name}</span>
                <EntityRowActions onPlay={() => onPlayTag(t.id)} onEnqueue={() => onEnqueueTag(t.id)} onDetails={() => onTagClick(t.id)} />
              </span>
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
              <div className="entity-list-content">
                <LikeDislikeButtons liked={t.liked} onToggleLike={() => onToggleLike(t.id)} onToggleDislike={() => onToggleDislike(t.id)} variant="inline" size={12} />
                <TagCardArt tag={t} imagePath={getTagImage(t.name)} className="entity-list-img" />
                <div className="entity-list-info">
                  <span className="entity-list-name">{t.name}</span>
                  <span className="entity-list-secondary">{t.track_count} tracks</span>
                </div>
              </div>
              <EntityRowActions onPlay={() => onPlayTag(t.id)} onEnqueue={() => onEnqueueTag(t.id)} onDetails={() => onTagClick(t.id)} />
            </div>
          ))}
          {tags.length === 0 && <div className="empty">No tags found.</div>}
        </div>
      )}

      {viewMode === "tiles" && (
        <div className="tiles-scroll">
          <div className="entity-grid">
            {tags.map((t, i) => (
              <div key={t.id} className={`tag-card${selectedIds.has(t.id) ? " selected" : ""}`} onClick={e => handleClick(e, i)} onMouseDown={e => handleMouseDown(e, t.id)} onContextMenu={e => handleCtxMenu(e, t)}>
                <div className="album-card-art-wrapper" onClick={e => { e.stopPropagation(); onTagClick(t.id); }}>
                  <TagCardArt tag={t} imagePath={getTagImage(t.name)} />
                  <LikeDislikeButtons liked={t.liked} onToggleLike={() => onToggleLike(t.id)} onToggleDislike={() => onToggleDislike(t.id)} variant="overlay" size={12} />
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
  albums, viewMode, getAlbumImage, onAlbumClick, onArtistClick, onToggleLike, onToggleDislike,
  onContextMenu, onMultiContextMenu, onPlayAlbum, onEnqueueAlbum, hasMore, loadingMore, onLoadMore,
  onSort, sortField, sortIndicator, selectedIds, onSelectionChange, lastClickedRef, onDragStart,
}: {
  albums: Album[];
  viewMode: ViewMode;
  getAlbumImage: (title: string, artistName?: string | null) => string | null;
  onAlbumClick: (id: number, artistId?: number | null) => void;
  onArtistClick: (artistId: number, name?: string) => void;
  onToggleLike: (id: number) => void;
  onToggleDislike: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, id: number) => void;
  onMultiContextMenu: (e: React.MouseEvent, albumIds: number[]) => void;
  onPlayAlbum: (albumId: number) => void;
  onEnqueueAlbum: (albumId: number) => void;
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
    if ((e.target as HTMLElement).closest('.track-link, .col-like, .album-card-menu-btn, .album-card-play-btn, .entity-list-play, .entity-list-enqueue, .entity-table-action, .row-hover-action')) return;
    const sel = computeIdSelection(selectedIds, index, ids, lastClickedRef.current, e.metaKey || e.ctrlKey, e.shiftKey);
    onSelectionChange(sel);
    lastClickedRef.current = index;
  }
  function handleMouseDown(e: React.MouseEvent, id: number) {
    if (e.button !== 0 || !selectedIds.has(id) || selectedIds.size < 2) return;
    if ((e.target as HTMLElement).closest('.track-link, .col-like, .album-card-menu-btn, .album-card-play-btn, .entity-list-play, .entity-list-enqueue, .entity-table-action, .row-hover-action')) return;
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
              <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} onToggleDislike={() => onToggleDislike(a.id)} variant="inline" size={12} />
              <span className="entity-table-name">
                <span className="entity-table-name-main">{a.title}</span>
                <EntityRowActions onPlay={() => onPlayAlbum(a.id)} onEnqueue={() => onEnqueueAlbum(a.id)} onDetails={() => onAlbumClick(a.id, a.artist_id)} />
              </span>
              <span className="entity-table-secondary">
                {a.artist_name && (
                  <span className="track-link" onClick={e => { e.stopPropagation(); onArtistClick(a.artist_id ?? 0, a.artist_name!); }}>{a.artist_name}</span>
                )}
              </span>
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
              <div className="entity-list-content">
                <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} onToggleDislike={() => onToggleDislike(a.id)} variant="inline" size={12} />
                <AlbumCardArt album={a} imagePath={getAlbumImage(a.title, a.artist_name)} />
                <div className="entity-list-info">
                  <span className="entity-list-name">{a.title}</span>
                  <span className="entity-list-secondary">
                    {a.artist_name && <><span className="track-link" onClick={e => { e.stopPropagation(); onArtistClick(a.artist_id ?? 0, a.artist_name!); }}>{a.artist_name}</span> {"\u00B7"} </>}
                    {a.year ? `${a.year} \u00B7 ` : ""}{a.track_count} tracks
                  </span>
                </div>
              </div>
              <EntityRowActions onPlay={() => onPlayAlbum(a.id)} onEnqueue={() => onEnqueueAlbum(a.id)} onDetails={() => onAlbumClick(a.id, a.artist_id)} />
            </div>
          ))}
          {albums.length === 0 && <div className="empty">No albums found.</div>}
        </div>
      )}

      {viewMode === "tiles" && (
        <div className="tiles-scroll">
          <div className="entity-grid">
            {albums.map((a, i) => (
              <div key={a.id} className={`album-card${selectedIds.has(a.id) ? " selected" : ""}`} onClick={e => handleClick(e, i)} onMouseDown={e => handleMouseDown(e, a.id)} onContextMenu={e => handleCtxMenu(e, a)}>
                <div className="album-card-art-wrapper" onClick={e => { e.stopPropagation(); onAlbumClick(a.id, a.artist_id); }}>
                  <AlbumCardArt album={a} imagePath={getAlbumImage(a.title, a.artist_name)} />
                  <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} onToggleDislike={() => onToggleDislike(a.id)} variant="overlay" size={12} />
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
  artists, viewMode, getArtistImage, onArtistClick, onToggleLike, onToggleDislike,
  onContextMenu, onMultiContextMenu, onPlayArtist, onEnqueueArtist, hasMore, loadingMore, onLoadMore,
  onSort, sortField, sortIndicator, selectedIds, onSelectionChange, lastClickedRef, onDragStart,
}: {
  artists: Artist[];
  viewMode: ViewMode;
  getArtistImage: (name: string) => string | null;
  onArtistClick: (id: number) => void;
  onToggleLike: (id: number) => void;
  onToggleDislike: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, id: number) => void;
  onMultiContextMenu: (e: React.MouseEvent, artistIds: number[]) => void;
  onPlayArtist: (artistId: number) => void;
  onEnqueueArtist: (artistId: number) => void;
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
    if ((e.target as HTMLElement).closest('.col-like, .album-card-menu-btn, .album-card-play-btn, .entity-list-play, .entity-list-enqueue, .entity-table-action, .row-hover-action')) return;
    const sel = computeIdSelection(selectedIds, index, ids, lastClickedRef.current, e.metaKey || e.ctrlKey, e.shiftKey);
    onSelectionChange(sel);
    lastClickedRef.current = index;
  }
  function handleMouseDown(e: React.MouseEvent, id: number) {
    if (e.button !== 0 || !selectedIds.has(id) || selectedIds.size < 2) return;
    if ((e.target as HTMLElement).closest('.col-like, .album-card-menu-btn, .album-card-play-btn, .entity-list-play, .entity-list-enqueue, .entity-table-action, .row-hover-action')) return;
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
              <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} onToggleDislike={() => onToggleDislike(a.id)} variant="inline" size={12} />
              <span className="entity-table-name">
                <span className="entity-table-name-main">{a.name}</span>
                <EntityRowActions onPlay={() => onPlayArtist(a.id)} onEnqueue={() => onEnqueueArtist(a.id)} onDetails={() => onArtistClick(a.id)} />
              </span>
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
              <div className="entity-list-content">
                <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} onToggleDislike={() => onToggleDislike(a.id)} variant="inline" size={12} />
                <ArtistCardArt artist={a} imagePath={getArtistImage(a.name)} className="entity-list-img circular" />
                <div className="entity-list-info">
                  <span className="entity-list-name">{a.name}</span>
                  <span className="entity-list-secondary">{a.track_count} tracks</span>
                </div>
              </div>
              <EntityRowActions onPlay={() => onPlayArtist(a.id)} onEnqueue={() => onEnqueueArtist(a.id)} onDetails={() => onArtistClick(a.id)} />
            </div>
          ))}
          {artists.length === 0 && <div className="empty">No artists found.</div>}
        </div>
      )}

      {viewMode === "tiles" && (
        <div className="tiles-scroll">
          <div className="entity-grid">
            {artists.map((a, i) => (
              <div key={a.id} className={`artist-card${selectedIds.has(a.id) ? " selected" : ""}`} onClick={e => handleClick(e, i)} onMouseDown={e => handleMouseDown(e, a.id)} onContextMenu={e => handleCtxMenu(e, a.id)}>
                <div className="album-card-art-wrapper" onClick={e => { e.stopPropagation(); onArtistClick(a.id); }}>
                  <ArtistCardArt artist={a} imagePath={getArtistImage(a.name)} />
                  <LikeDislikeButtons liked={a.liked} onToggleLike={() => onToggleLike(a.id)} onToggleDislike={() => onToggleDislike(a.id)} variant="overlay" size={12} />
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
