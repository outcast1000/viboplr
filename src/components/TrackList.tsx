import { useState, useEffect, useRef } from "react";
import type { Track, SortField, TrackColumnId, ColumnConfig } from "../types";
import { isVideoTrack, formatDuration } from "../utils";
import { IconYoutube } from "./Icons";
import { openUrl } from "@tauri-apps/plugin-opener";

const COLUMN_DISPLAY_NAMES: Record<TrackColumnId, string> = {
  like: "Liked",
  num: "#",
  title: "Title",
  artist: "Artist",
  album: "Album",
  duration: "Duration",
  path: "Path",
  year: "Year",
  quality: "Quality",
  size: "Size",
  collection: "Collection",
  added: "Added",
  modified: "Modified",
};

const COLUMN_SORT_FIELDS: Partial<Record<TrackColumnId, SortField>> = {
  num: "num",
  title: "title",
  artist: "artist",
  album: "album",
  duration: "duration",
  path: "path",
  year: "year",
  quality: "quality",
  size: "size",
  collection: "collection",
  added: "added",
  modified: "modified",
};

function formatFileSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatQuality(track: Track): string {
  const fmt = track.format?.toUpperCase() ?? "";
  if (track.duration_secs && track.file_size) {
    const kbps = Math.round(track.file_size * 8 / track.duration_secs / 1000);
    return fmt ? `${fmt} ${kbps}kbps` : `${kbps}kbps`;
  }
  return fmt;
}

function formatDate(epochSecs: number | null): string {
  if (!epochSecs) return "";
  return new Date(epochSecs * 1000).toLocaleDateString();
}

function filenameFromPath(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  return path.split(sep).pop() ?? path;
}

export function computeSelection(
  current: Set<number>,
  clickedIndex: number,
  tracks: Track[],
  lastIndex: number | null,
  meta: boolean,
  shift: boolean,
): Set<number> {
  if (shift) {
    const start = lastIndex ?? 0;
    const lo = Math.min(start, clickedIndex);
    const hi = Math.max(start, clickedIndex);
    const range = new Set(tracks.slice(lo, hi + 1).map(t => t.id));
    if (meta) {
      const merged = new Set(current);
      for (const id of range) merged.add(id);
      return merged;
    }
    return range;
  }
  if (meta) {
    const next = new Set(current);
    if (next.has(tracks[clickedIndex].id)) {
      next.delete(tracks[clickedIndex].id);
    } else {
      next.add(tracks[clickedIndex].id);
    }
    return next;
  }
  return new Set([tracks[clickedIndex].id]);
}

interface TrackListProps {
  tracks: Track[];
  currentTrack: Track | null;
  highlightedIndex: number;
  sortField: SortField | null;
  trackListRef: React.RefObject<HTMLDivElement | null>;
  columns: ColumnConfig[];
  onColumnsChange: (columns: ColumnConfig[]) => void;
  onDoubleClick: (tracks: Track[], index: number) => void;
  onContextMenu: (e: React.MouseEvent, track: Track, selectedTrackIds: Set<number>) => void;
  onArtistClick: (artistId: number) => void;
  onAlbumClick: (albumId: number, artistId?: number | null) => void;
  onSort: (field: SortField) => void;
  sortIndicator: (field: SortField) => string;
  onToggleLike: (track: Track) => void;
  onTrackDragStart?: (tracks: Track[]) => void;
  emptyMessage?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

export function TrackList({
  tracks, currentTrack, highlightedIndex,
  sortField, trackListRef, columns, onColumnsChange,
  onDoubleClick, onContextMenu, onArtistClick, onAlbumClick,
  onSort, sortIndicator, onToggleLike, onTrackDragStart,
  emptyMessage = "No tracks found.",
  hasMore = false, loadingMore = false, onLoadMore,
}: TrackListProps) {
  const [columnMenuPos, setColumnMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [draggedCol, setDraggedCol] = useState<TrackColumnId | null>(null);
  const [dragOverCol, setDragOverCol] = useState<TrackColumnId | null>(null);
  const draggedRef = useRef<TrackColumnId | null>(null);
  const dragOverRef = useRef<TrackColumnId | null>(null);
  const didDragRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const didDragRowRef = useRef(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const lastClickedIndexRef = useRef<number | null>(null);

  useEffect(() => {
    if (!hasMore || !onLoadMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          onLoadMore();
        }
      },
      { threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore]);

  const prevTrackIdsRef = useRef<string>("");
  useEffect(() => {
    const currFirst = String(tracks[0]?.id ?? "");
    const prevFirst = prevTrackIdsRef.current.split(":")[0];
    if (prevTrackIdsRef.current && prevFirst !== currFirst) {
      setSelectedIds(new Set());
      lastClickedIndexRef.current = null;
    }
    prevTrackIdsRef.current = currFirst + ":" + tracks.length;
  }, [tracks]);

  const visibleColumns = columns.filter(c => c.visible);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (columnMenuPos) {
          setColumnMenuPos(null);
        } else if (selectedIds.size > 0) {
          setSelectedIds(new Set());
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [columnMenuPos, selectedIds.size]);

  function handleRowClick(e: React.MouseEvent, index: number) {
    if (didDragRowRef.current) return;
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest('.track-link, .col-like, .track-youtube-link')) {
      return;
    }
    const newSelection = computeSelection(
      selectedIds, index, tracks, lastClickedIndexRef.current,
      e.metaKey || e.ctrlKey, e.shiftKey,
    );
    setSelectedIds(newSelection);
    lastClickedIndexRef.current = index;
  }

  function handleRowMouseDown(e: React.MouseEvent, index: number) {
    if (e.button !== 0 || !onTrackDragStart) return;
    if ((e.target as HTMLElement).closest('.track-link, .col-like, .track-youtube-link')) return;

    const startX = e.clientX;
    const startY = e.clientY;
    didDragRowRef.current = false;

    function onMouseMove(ev: MouseEvent) {
      if (didDragRowRef.current) return; // already handed off
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) < 5) return;

      didDragRowRef.current = true;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);

      // Determine which tracks to drag
      let dragTracks: Track[];
      if (selectedIds.has(tracks[index].id) && selectedIds.size > 1) {
        dragTracks = tracks.filter(t => selectedIds.has(t.id));
      } else {
        dragTracks = [tracks[index]];
      }
      onTrackDragStart!(dragTracks);
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      setTimeout(() => { didDragRowRef.current = false; }, 0);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  function handleHeaderContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    setColumnMenuPos({ x: e.clientX, y: e.clientY });
  }

  function toggleColumnVisibility(id: TrackColumnId) {
    onColumnsChange(columns.map(c => c.id === id ? { ...c, visible: !c.visible } : c));
  }

  const ghostRef = useRef<HTMLDivElement | null>(null);

  function handleColMouseDown(e: React.MouseEvent, id: TrackColumnId) {
    if (e.button !== 0) return;
    draggedRef.current = id;
    dragOverRef.current = null;
    didDragRef.current = false;

    function findColId(el: Element | null): TrackColumnId | null {
      while (el) {
        const colId = el.getAttribute("data-col-id");
        if (colId) return colId as TrackColumnId;
        el = el.parentElement;
      }
      return null;
    }

    function showGhost(x: number, y: number) {
      if (!ghostRef.current) {
        const ghost = document.createElement("div");
        ghost.className = "col-drag-ghost";
        ghost.textContent = COLUMN_DISPLAY_NAMES[id] || id;
        document.body.appendChild(ghost);
        ghostRef.current = ghost;
      }
      ghostRef.current.style.left = `${x + 12}px`;
      ghostRef.current.style.top = `${y - 10}px`;
    }

    function removeGhost() {
      if (ghostRef.current) {
        ghostRef.current.remove();
        ghostRef.current = null;
      }
    }

    function onMouseMove(ev: MouseEvent) {
      if (!draggedRef.current) return;
      if (!didDragRef.current) {
        didDragRef.current = true;
        setDraggedCol(draggedRef.current);
      }
      showGhost(ev.clientX, ev.clientY);
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const overId = target ? findColId(target) : null;
      if (overId && overId !== draggedRef.current) {
        dragOverRef.current = overId;
        setDragOverCol(overId);
      } else if (!overId || overId === draggedRef.current) {
        dragOverRef.current = null;
        setDragOverCol(null);
      }
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      removeGhost();
      const from = draggedRef.current;
      const to = dragOverRef.current;
      if (didDragRef.current && from && to && from !== to) {
        const newCols = [...columns];
        const fromIdx = newCols.findIndex(c => c.id === from);
        const toIdx = newCols.findIndex(c => c.id === to);
        if (fromIdx !== -1 && toIdx !== -1) {
          const [moved] = newCols.splice(fromIdx, 1);
          newCols.splice(toIdx, 0, moved);
          onColumnsChange(newCols);
        }
      }
      draggedRef.current = null;
      dragOverRef.current = null;
      setDraggedCol(null);
      setDragOverCol(null);
      setTimeout(() => { didDragRef.current = false; }, 0);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  function renderHeaderCell(col: ColumnConfig) {
    const sf = COLUMN_SORT_FIELDS[col.id];
    const isSortable = !!sf;
    const classes = [
      `col-${col.id}`,
      isSortable ? "sortable" : "",
      isSortable && sortField === sf ? "sorted" : "",
      dragOverCol === col.id ? "drag-over" : "",
      draggedCol === col.id ? "dragging" : "",
    ].filter(Boolean).join(" ");

    const label = col.id === "like" ? "" : COLUMN_DISPLAY_NAMES[col.id];
    const arrow = isSortable ? sortIndicator(sf!) : "";

    return (
      <span
        key={col.id}
        className={classes}
        data-col-id={col.id}
        onClick={isSortable ? () => { if (!didDragRef.current) onSort(sf!); } : undefined}
        onMouseDown={(e) => handleColMouseDown(e, col.id)}
      >
        <span className="col-header-label">{label}</span>
        {arrow && <span className="col-header-sort">{arrow}</span>}
      </span>
    );
  }

  function renderCell(col: ColumnConfig, t: Track, i: number) {
    switch (col.id) {
      case "like":
        return (
          <span key="like" className="col-like" onClick={(e) => { e.stopPropagation(); onToggleLike(t); }}>
            {t.liked ? "\u2665" : "\u2661"}
          </span>
        );
      case "num":
        return (
          <span key="num" className="col-num">
            {isVideoTrack(t) ? "\uD83C\uDFAC" : (t.track_number || i + 1)}
          </span>
        );
      case "title":
        return (
          <span key="title" className="col-title">
            {t.title}
            {t.youtube_url && (
              <span
                className="track-youtube-link"
                title="Open on YouTube"
                onClick={(e) => { e.stopPropagation(); openUrl(t.youtube_url!); }}
              >
                <IconYoutube size={16} />
              </span>
            )}
          </span>
        );
      case "artist":
        return (
          <span key="artist" className="col-artist">
            {t.artist_id ? (
              <span className="track-link" onClick={(e) => { e.stopPropagation(); onArtistClick(t.artist_id!); }}>{t.artist_name || "Unknown"}</span>
            ) : (t.artist_name || "Unknown")}
          </span>
        );
      case "album":
        return (
          <span key="album" className="col-album">
            {t.album_id ? (
              <span className="track-link" onClick={(e) => { e.stopPropagation(); onAlbumClick(t.album_id!, t.artist_id); }}>{t.album_title || "Unknown"}</span>
            ) : (t.album_title || "Unknown")}
          </span>
        );
      case "duration":
        return <span key="duration" className="col-duration">{formatDuration(t.duration_secs)}</span>;
      case "path":
        return <span key="path" className="col-path" title={t.path}>{filenameFromPath(t.path)}</span>;
      case "year":
        return <span key="year" className="col-year">{t.year ?? ""}</span>;
      case "quality":
        return <span key="quality" className="col-quality">{formatQuality(t)}</span>;
      case "size":
        return <span key="size" className="col-size">{formatFileSize(t.file_size)}</span>;
      case "collection":
        return <span key="collection" className="col-collection">{t.collection_name ?? ""}</span>;
      case "added":
        return <span key="added" className="col-added">{formatDate(t.added_at)}</span>;
      case "modified":
        return <span key="modified" className="col-modified">{formatDate(t.modified_at)}</span>;
    }
  }

  return (
    <div className="track-list" ref={trackListRef}>
      <div className="track-header" onContextMenu={handleHeaderContextMenu}>
        {visibleColumns.map(col => renderHeaderCell(col))}
      </div>
      {tracks.map((t, i) => (
        <div
          key={t.id}
          className={`track-row ${currentTrack?.id === t.id ? "playing" : ""} ${highlightedIndex === i ? "highlighted" : ""} ${selectedIds.has(t.id) ? "selected" : ""}`}
          onMouseDown={(e) => handleRowMouseDown(e, i)}
          onClick={(e) => handleRowClick(e, i)}
          onDoubleClick={() => { setSelectedIds(new Set()); onDoubleClick([tracks[i]], 0); }}
          onContextMenu={(e) => {
            if (!selectedIds.has(t.id)) {
              setSelectedIds(new Set([t.id]));
              lastClickedIndexRef.current = i;
              onContextMenu(e, t, new Set([t.id]));
            } else {
              onContextMenu(e, t, selectedIds.size > 1 ? selectedIds : new Set([t.id]));
            }
          }}
        >
          {visibleColumns.map(col => renderCell(col, t, i))}
        </div>
      ))}
      {hasMore && (
        <div ref={sentinelRef} className="track-list-sentinel">
          {loadingMore && <div className="track-list-loading">Loading more tracks...</div>}
        </div>
      )}
      {tracks.length === 0 && (
        <div className="empty">{emptyMessage}</div>
      )}

      {columnMenuPos && (
        <>
          <div className="column-menu-backdrop" onClick={() => setColumnMenuPos(null)} />
          <div className="column-menu" style={{ top: columnMenuPos.y, left: columnMenuPos.x }}>
            <div className="column-menu-title">Columns</div>
            {columns.map(col => (
              <label key={col.id} className="column-menu-item">
                <input
                  type="checkbox"
                  checked={col.visible}
                  onChange={() => toggleColumnVisibility(col.id)}
                />
                {COLUMN_DISPLAY_NAMES[col.id]}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
