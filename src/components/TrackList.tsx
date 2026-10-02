import { memo, useState, useEffect, useRef, useMemo, useId } from "react";
import type { Track, QueueTrack, SortField, TrackColumnId, ColumnConfig } from "../types";
import { isVideoTrack, formatDuration, formatFileSize } from "../utils";
import { formatCompactCount } from "../utils/formatCount";
import { computeSelection as computeSelectionGeneric } from "../utils/rowSelection";
import { isPlayingLibraryRow } from "../queueEntry";
import { trackLikeId } from "../utils/likeReconcile";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { RowHoverActions } from "./RowHoverActions";
import { SpinningDisc } from "./SpinningDisc";
import { showNativeMenu, type MenuItemSpec } from "../nativeMenu";
import { useAssignRef } from "../hooks/useLatestRef";
import { usePointerFocusGuard } from "../hooks/usePointerFocusGuard";
import "./TrackList.css";

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
  popularity: "Popularity",
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
  popularity: "popularity",
};


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


// Thin adapter over the shared generic (src/utils/rowSelection.ts): maps the
// Track[] to their row **ids**. Kept as a named export so existing callers
// (SearchView, computeSelection.test.ts) share one algorithm.
//
// Keyed on `id` — the row's only identity (a library Track carries no key; the
// old `lib:{id}` token merely restated this number as a string, so selecting by
// it meant parsing the id back out). `id` is `number | null` on the type but never
// null in a list — Rust's `Track.id` is a non-optional `i64`, and the only
// id-less Tracks in the app are three synthetic literals that feed a detail
// page, never a list. The generic is parameterised over the key type, so the
// null rides through harmlessly rather than needing a sentinel.
export function computeSelection(
  current: Set<number | null>,
  clickedIndex: number,
  tracks: Track[],
  lastIndex: number | null,
  meta: boolean,
  shift: boolean,
): Set<number | null> {
  return computeSelectionGeneric(current, clickedIndex, tracks.map(t => t.id), lastIndex, meta, shift);
}

/** A track the list shows without a library row behind it — an album page's
 *  provider tracklist entry (or an artist's Top Song) the user doesn't own.
 *  Read-only: it gets the same hover actions as a library row — play,
 *  enqueue, start radio, details — plus download, and the track context
 *  menu, all by metadata (the stream resolvers find it at play time; the
 *  download follows the same resolver order), but is never
 *  selected, dragged, deleted or liked from here. */
export interface MissingTrackRow {
  track: QueueTrack;
  /** Drawn before `tracks[before]`; `tracks.length` puts it after the last. */
  before: number;
  /** What the # column shows (its position on the album). */
  number?: number;
  popularity?: number;
}

interface TrackListProps {
  tracks: Track[];
  currentTrack: QueueTrack | null;
  playing?: boolean;
  highlightedIndex: number;
  sortField: SortField | null;
  trackListRef: React.RefObject<HTMLDivElement | null>;
  columns: ColumnConfig[];
  onColumnsChange: (columns: ColumnConfig[]) => void;
  onDoubleClick: (tracks: Track[], index: number) => void;
  onContextMenu: (e: React.MouseEvent, track: Track, selectedTracks: Track[]) => void;
  onArtistClick: (artistId: number, name?: string) => void;
  onAlbumClick: (albumId: number, artistId?: number | null, name?: string, artistName?: string) => void;
  onSort: (field: SortField) => void;
  sortIndicator: (field: SortField) => string;
  onToggleLike: (track: Track) => void;
  onToggleDislike?: (track: Track) => void;
  onTrackDragStart?: (tracks: Track[]) => void;
  onDeleteTracks?: (trackIds: number[]) => void;
  onPlay?: (track: Track) => void;
  onEnqueue?: (track: Track) => void;
  /** When provided, the hover overlay shows a "Start radio" button. */
  onStartRadio?: (track: Track) => void;
  onLocateTrack?: (track: Track) => void;
  trackPopularity?: Record<number, number>;
  emptyMessage?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** Accessible name for the listbox (screen readers). */
  ariaLabel?: string;
  /** Rows interleaved with `tracks` that have no library copy (see
   *  MissingTrackRow). Not part of the selection or the keyboard cursor. */
  missingRows?: MissingTrackRow[];
  onPlayMissing?: (track: QueueTrack) => void;
  onEnqueueMissing?: (track: QueueTrack) => void;
  onStartRadioMissing?: (track: QueueTrack) => void;
  /** Open the track page by name (no library row to open by id). */
  onLocateMissing?: (track: QueueTrack) => void;
  /** When provided, missing rows get a hover "Download" button. */
  onDownloadMissing?: (track: QueueTrack) => void;
  onMissingContextMenu?: (e: React.MouseEvent, track: QueueTrack) => void;
}

const NO_MISSING: MissingTrackRow[] = [];

export function TrackList({
  tracks, currentTrack, playing, highlightedIndex,
  sortField, trackListRef, columns, onColumnsChange,
  onDoubleClick, onContextMenu, onArtistClick, onAlbumClick,
  onSort, sortIndicator, onToggleLike, onToggleDislike, onTrackDragStart,
  onDeleteTracks, onPlay, onEnqueue, onStartRadio, onLocateTrack, trackPopularity,
  emptyMessage = "No tracks found.",
  hasMore = false, loadingMore = false, onLoadMore,
  ariaLabel = "Tracks",
  missingRows = NO_MISSING, onPlayMissing, onEnqueueMissing, onStartRadioMissing, onLocateMissing, onDownloadMissing, onMissingContextMenu,
}: TrackListProps) {
  const maxPopularity = useMemo(() => {
    const missing = missingRows.map(m => m.popularity ?? 0);
    return Math.max(0, ...Object.values(trackPopularity ?? {}), ...missing);
  }, [trackPopularity, missingRows]);

  // Missing rows grouped by the library row they precede, in the order given.
  const missingBefore = useMemo(() => {
    const byIndex = new Map<number, MissingTrackRow[]>();
    for (const m of missingRows) {
      const at = Math.min(Math.max(m.before, 0), tracks.length);
      const list = byIndex.get(at);
      if (list) list.push(m); else byIndex.set(at, [m]);
    }
    return byIndex;
  }, [missingRows, tracks.length]);
  const playingId = currentTrack ? trackLikeId(currentTrack.title, currentTrack.artist_name) : null;

  const [draggedCol, setDraggedCol] = useState<TrackColumnId | null>(null);
  const [dragOverCol, setDragOverCol] = useState<TrackColumnId | null>(null);
  const draggedRef = useRef<TrackColumnId | null>(null);
  const dragOverRef = useRef<TrackColumnId | null>(null);
  const didDragRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const didDragRowRef = useRef(false);
  const [selectedIds, setSelectedIds] = useState<Set<number | null>>(new Set());
  // Keyboard cursor for the listbox (aria-activedescendant). -1 = none yet.
  const [activeIndex, setActiveIndex] = useState(-1);
  const listId = useId();
  const optionId = (i: number) => `${listId}opt${i}`;
  const lastClickedIndexRef = useRef<number | null>(null);
  const focusGuard = usePointerFocusGuard();

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

  // Drop the selection when the list becomes a different list (a new search, a
  // filter, a different album, a reorder), keyed on the full id *sequence*.
  //
  // The sequence — not just the first row — is load-bearing: `selectedIds` is
  // what Delete acts on, visible or not, so a selection that survives a filter
  // which happens to keep row 0 (typing the first track's title prefix) would
  // carry hidden rows into a trash delete — with no confirmation at all when
  // `confirmTrashDelete` is off. Only an in-place patch (a like toggled on a
  // row) keeps the ids identical and the selection with it; any membership or
  // order change also invalidates `lastClickedIndexRef`, so both reset
  // together. (An earlier `"<key>:<length>"` string compare was broken the
  // other way — a key *contains* a colon, so it cleared on every change,
  // including in-place patches.) `null` is the "no previous list" sentinel;
  // row ids inside the array can legitimately be null.
  const prevIdsRef = useRef<Array<number | null> | null>(null);
  useEffect(() => {
    const ids = tracks.map(t => t.id);
    const prev = prevIdsRef.current;
    const sameList = prev !== null && prev.length === ids.length && prev.every((id, i) => id === ids[i]);
    if (prev !== null && !sameList) {
      setSelectedIds(new Set());
      setActiveIndex(-1);
      lastClickedIndexRef.current = null;
    }
    prevIdsRef.current = ids;
  }, [tracks]);

  // Memoized: this array is a TrackRow prop, and a fresh identity per render
  // would defeat the row memo below.
  const visibleColumns = useMemo(() => columns.filter(c => c.visible), [columns]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (selectedIds.size > 0) {
          setSelectedIds(new Set());
        }
      } else if (e.key === "a" && (e.metaKey || e.ctrlKey) && tracks.length > 0) {
        if ((e.target as HTMLElement)?.closest("input, textarea, [contenteditable]")) return;
        e.preventDefault();
        setSelectedIds(new Set(tracks.map(t => t.id)));
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.size > 0 && onDeleteTracks) {
        if ((e.target as HTMLElement)?.closest("input, textarea, [contenteditable]")) return;
        e.preventDefault();
        // The selection *is* the id set now, so this is a straight read — it
        // used to parse each id back out of a `lib:N` key. Nulls are filtered
        // because `Track.id` is nullable on the type (never in a list).
        onDeleteTracks([...selectedIds].filter((id): id is number => id != null));
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIds, onDeleteTracks, tracks]);

  // Scroll the keyboard cursor's option into view as it moves.
  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Move the keyboard cursor; selection either follows (single) or extends (shift).
  function moveActive(next: number, extend: boolean) {
    if (tracks.length === 0) return;
    const clamped = Math.max(0, Math.min(next, tracks.length - 1));
    setActiveIndex(clamped);
    if (extend) {
      setSelectedIds(computeSelection(selectedIds, clamped, tracks, lastClickedIndexRef.current, false, true));
    } else {
      setSelectedIds(new Set([tracks[clamped].id]));
      lastClickedIndexRef.current = clamped;
    }
  }

  // Listbox keyboard nav. Only acts when the list container itself holds focus
  // (aria-activedescendant model) — inner buttons keep their own key handling.
  function handleListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget || tracks.length === 0) return;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); moveActive(activeIndex < 0 ? 0 : activeIndex + 1, e.shiftKey); break;
      case "ArrowUp": e.preventDefault(); moveActive(activeIndex < 0 ? 0 : activeIndex - 1, e.shiftKey); break;
      case "Home": e.preventDefault(); moveActive(0, e.shiftKey); break;
      case "End": e.preventDefault(); moveActive(tracks.length - 1, e.shiftKey); break;
      case "Enter":
        if (activeIndex >= 0) {
          e.preventDefault();
          if (e.shiftKey) { onEnqueue?.(tracks[activeIndex]); }
          else { setSelectedIds(new Set()); onDoubleClick([tracks[activeIndex]], 0); }
        }
        break;
      case " ":
        if (activeIndex >= 0) {
          e.preventDefault();
          setSelectedIds(computeSelection(selectedIds, activeIndex, tracks, lastClickedIndexRef.current, true, false));
          lastClickedIndexRef.current = activeIndex;
        }
        break;
    }
  }

  // First keyboard focus on the list seeds the cursor so the active option is
  // announced. Not a click's focus: see usePointerFocusGuard.
  function handleListFocus(e: React.FocusEvent<HTMLDivElement>) {
    if (focusGuard.isPointerFocus()) return;
    if (e.target === e.currentTarget && activeIndex < 0 && tracks.length > 0) setActiveIndex(0);
  }

  function handleRowClick(e: React.MouseEvent, index: number) {
    if (didDragRowRef.current) return;
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest('.track-link, .col-like, .row-hover-action')) {
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
    if ((e.target as HTMLElement).closest('.track-link, .col-like, .row-hover-action')) return;

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

  function toggleColumnVisibility(id: TrackColumnId) {
    onColumnsChange(columns.map(c => c.id === id ? { ...c, visible: !c.visible } : c));
  }

  function handleHeaderContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const specs: MenuItemSpec[] = columns.map(col => ({
      kind: "check",
      text: COLUMN_DISPLAY_NAMES[col.id],
      checked: col.visible,
      action: () => toggleColumnVisibility(col.id),
    }));
    showNativeMenu(e.clientX, e.clientY, specs).catch((err) =>
      console.error("Failed to show column menu:", err)
    );
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

  // The mutable half of the row contract (see TrackRow below): rebuilt with
  // fresh closures every render, reached by rows through a ref whose identity
  // never changes \u2014 the same latestRef pattern as QueuePanel's QueueRow.
  const rowHandlersRef = useRef<TrackRowHandlers>(null!);
  useAssignRef(rowHandlersRef, {
    mouseDown: handleRowMouseDown,
    click: handleRowClick,
    doubleClick: (index: number) => { setSelectedIds(new Set()); onDoubleClick([tracks[index]], 0); },
    contextMenu: (e: React.MouseEvent, t: Track, index: number) => {
      if (!selectedIds.has(t.id)) {
        setSelectedIds(new Set([t.id]));
        lastClickedIndexRef.current = index;
        onContextMenu(e, t, [t]);
      } else {
        onContextMenu(e, t, selectedIds.size > 1 ? tracks.filter(x => selectedIds.has(x.id)) : [t]);
      }
    },
    artistClick: onArtistClick,
    albumClick: onAlbumClick,
    toggleLike: onToggleLike,
    toggleDislike: onToggleDislike,
    play: onPlay,
    enqueue: onEnqueue,
    startRadio: onStartRadio,
    locate: onLocateTrack,
    playMissing: onPlayMissing,
    enqueueMissing: onEnqueueMissing,
    startRadioMissing: onStartRadioMissing,
    locateMissing: onLocateMissing,
    downloadMissing: onDownloadMissing,
    missingContextMenu: onMissingContextMenu,
  });

  // Which optional actions exist decides what the row renders (hover buttons,
  // the dislike half of the like control) \u2014 the ref above hides handler
  // identity, so presence rides its own memoized prop.
  // Keyed on presence (booleans), not on handler identity.
  const hasPlay = !!onPlay;
  const hasEnqueue = !!onEnqueue;
  const hasStartRadio = !!onStartRadio;
  const hasLocate = !!onLocateTrack;
  const hasDislike = !!onToggleDislike;
  const hasStartRadioMissing = !!onStartRadioMissing;
  const hasLocateMissing = !!onLocateMissing;
  const hasDownloadMissing = !!onDownloadMissing;
  const presence = useMemo<TrackRowActionPresence>(() => ({
    play: hasPlay,
    enqueue: hasEnqueue,
    startRadio: hasStartRadio,
    locate: hasLocate,
    dislike: hasDislike,
    startRadioMissing: hasStartRadioMissing,
    locateMissing: hasLocateMissing,
    downloadMissing: hasDownloadMissing,
  }), [hasPlay, hasEnqueue, hasStartRadio, hasLocate, hasDislike, hasStartRadioMissing, hasLocateMissing, hasDownloadMissing]);

  // Infinite scroll appends pages without bound, so a large library can
  // accumulate thousands of rows. Above a threshold, opt each row into
  // `content-visibility: auto` so the browser skips layout/paint for the
  // off-screen ones — same approach as the plugin track-row list, and it keeps
  // the single scroll container, the ARIA option indices, and the sentinel.
  const useCv = tracks.length > 100;

  return (
    <div
      className={`track-list${useCv ? " track-list-cv" : ""}`}
      ref={trackListRef}
      role="listbox"
      aria-multiselectable="true"
      aria-label={ariaLabel}
      aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
      tabIndex={0}
      onKeyDown={handleListKeyDown}
      onMouseDownCapture={focusGuard.onMouseDownCapture}
      onFocus={handleListFocus}
    >
      <div className="track-header" role="presentation" onContextMenu={handleHeaderContextMenu}>
        {visibleColumns.map(col => renderHeaderCell(col))}
      </div>
      {[...tracks, null].map((t, i) => {
        const missingHere = missingBefore.get(i)?.map(m => (
          <MissingRow
            key={`m:${m.track.key}`}
            row={m}
            isCurrent={playingId !== null && playingId === trackLikeId(m.track.title, m.track.artist_name)}
            visibleColumns={visibleColumns}
            presence={presence}
            maxPopularity={maxPopularity}
            handlers={rowHandlersRef}
          />
        ));
        if (t === null) return missingHere ?? null;
        const isCurrent = isPlayingLibraryRow(t, currentTrack);
        const row = (
          <TrackRow
            key={t.id}
            track={t}
            index={i}
            optId={optionId(i)}
            isCurrent={isCurrent}
            spinning={isCurrent && playing != null ? playing : null}
            isHighlighted={highlightedIndex === i}
            isActive={activeIndex === i}
            isSelected={selectedIds.has(t.id)}
            visibleColumns={visibleColumns}
            presence={presence}
            popularity={t.id != null ? trackPopularity?.[t.id] : undefined}
            maxPopularity={maxPopularity}
            handlers={rowHandlersRef}
          />
        );
        return missingHere ? [...missingHere, row] : row;
      })}
      {hasMore && (
        <div ref={sentinelRef} className="track-list-sentinel">
          {loadingMore && <div className="track-list-loading">Loading more tracks...</div>}
        </div>
      )}
      {tracks.length === 0 && missingRows.length === 0 && (
        <div className="empty">{emptyMessage}</div>
      )}
    </div>
  );
}

/** Everything a row may call back into. Rebuilt with fresh closures on every
 *  TrackList render and reached through a stable ref, so rows never re-render
 *  just because a handler closure was recreated. */
interface TrackRowHandlers {
  mouseDown: (e: React.MouseEvent, index: number) => void;
  click: (e: React.MouseEvent, index: number) => void;
  doubleClick: (index: number) => void;
  contextMenu: (e: React.MouseEvent, t: Track, index: number) => void;
  artistClick: (artistId: number, name?: string) => void;
  albumClick: (albumId: number, artistId?: number | null, name?: string, artistName?: string) => void;
  toggleLike: (track: Track) => void;
  toggleDislike?: (track: Track) => void;
  play?: (track: Track) => void;
  enqueue?: (track: Track) => void;
  startRadio?: (track: Track) => void;
  locate?: (track: Track) => void;
  playMissing?: (track: QueueTrack) => void;
  enqueueMissing?: (track: QueueTrack) => void;
  startRadioMissing?: (track: QueueTrack) => void;
  locateMissing?: (track: QueueTrack) => void;
  downloadMissing?: (track: QueueTrack) => void;
  missingContextMenu?: (e: React.MouseEvent, track: QueueTrack) => void;
}

/** Which optional actions this surface wired up — drives what renders (hover
 *  buttons, the dislike half), since the handlers ref hides identity. */
interface TrackRowActionPresence {
  play: boolean;
  enqueue: boolean;
  startRadio: boolean;
  locate: boolean;
  dislike: boolean;
  startRadioMissing: boolean;
  locateMissing: boolean;
  downloadMissing: boolean;
}

interface TrackRowProps {
  track: Track;
  index: number;
  optId: string;
  isCurrent: boolean;
  /** Non-null only for the current row when a `playing` prop was supplied —
   *  renders the spinning disc in the # cell. Scoped this way so a play/pause
   *  toggle re-renders one row, not the list. */
  spinning: boolean | null;
  isHighlighted: boolean;
  isActive: boolean;
  isSelected: boolean;
  visibleColumns: ColumnConfig[];
  presence: TrackRowActionPresence;
  popularity: number | undefined;
  maxPopularity: number;
  handlers: React.RefObject<TrackRowHandlers>;
}

// memo'd row, same pattern as QueuePanel's QueueRow: every accumulated page of
// rows used to be reconciled on each TrackList render (a selection click alone
// recreated thousands of cell elements on a scrolled library) — now only rows
// whose flags actually changed re-render. `content-visibility: auto` above
// 100 rows still skips layout/paint, but only this skips reconciliation.
const TrackRow = memo(function TrackRow({
  track: t, index, optId, isCurrent, spinning, isHighlighted, isActive, isSelected,
  visibleColumns, presence, popularity, maxPopularity, handlers,
}: TrackRowProps) {
  const showRowActions = presence.play || presence.enqueue;

  function renderCell(col: ColumnConfig) {
    switch (col.id) {
      case "like":
        return (
          <span key="like" className="col-like">
            <LikeDislikeButtons
              liked={t.liked}
              onToggleLike={() => handlers.current.toggleLike(t)}
              onToggleDislike={presence.dislike ? () => handlers.current.toggleDislike?.(t) : undefined}
              variant="inline"
              size={12}
            />
          </span>
        );
      case "num": {
        if (spinning != null) {
          return (
            <span key="num" className="col-num">
              <SpinningDisc size={14} playing={spinning} />
            </span>
          );
        }
        return (
          <span key="num" className="col-num">
            {isVideoTrack(t) ? "🎬" : (t.track_number || index + 1)}
          </span>
        );
      }
      case "title":
        return (
          <span key="title" className="col-title">
            <span className="col-title-main">
              <span className="col-title-text">{t.title}</span>
            </span>
            {showRowActions && (
              <RowHoverActions
                onPlay={presence.play ? () => handlers.current.play?.(t) : undefined}
                onEnqueue={presence.enqueue ? () => handlers.current.enqueue?.(t) : undefined}
                onStartRadio={presence.startRadio ? () => handlers.current.startRadio?.(t) : undefined}
                onDetails={presence.locate ? () => handlers.current.locate?.(t) : undefined}
              />
            )}
          </span>
        );
      case "artist":
        return (
          <span key="artist" className="col-artist">
            {t.artist_name ? (
              <span className="track-link" onClick={(e) => { e.stopPropagation(); handlers.current.artistClick(t.artist_id ?? 0, t.artist_name!); }}>{t.artist_name}</span>
            ) : "Unknown"}
          </span>
        );
      case "album":
        return (
          <span key="album" className="col-album">
            {t.album_title ? (
              <span className="track-link" onClick={(e) => { e.stopPropagation(); handlers.current.albumClick(t.album_id ?? 0, t.artist_id, t.album_title!, t.artist_name ?? undefined); }}>{t.album_title}</span>
            ) : "Unknown"}
          </span>
        );
      case "duration":
        return <span key="duration" className="col-duration">{formatDuration(t.duration_secs)}</span>;
      case "path":
        return <span key="path" className="col-path" title={t.path ?? ""}>{(t.path ?? "").replace(/^file:\/\//, "")}</span>;
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
      case "popularity": {
        const pct = (popularity != null && maxPopularity > 0) ? (popularity / maxPopularity) * 100 : 0;
        return (
          <span key="popularity" className="col-popularity">
            {popularity != null ? (
              <>
                <span className="popularity-fill" style={{ width: `${pct}%` }} />
                <span className="popularity-count">{formatCompactCount(popularity)}</span>
              </>
            ) : null}
          </span>
        );
      }
    }
  }

  return (
    <div
      role="option"
      id={optId}
      aria-selected={isSelected}
      className={`track-row ${isCurrent ? "playing" : ""} ${isHighlighted ? "highlighted" : ""} ${isActive ? "active" : ""} ${isSelected ? "selected" : ""}`}
      onMouseDown={(e) => handlers.current.mouseDown(e, index)}
      onClick={(e) => handlers.current.click(e, index)}
      onDoubleClick={() => handlers.current.doubleClick(index)}
      onContextMenu={(e) => handlers.current.contextMenu(e, t, index)}
    >
      {visibleColumns.map(col => renderCell(col))}
    </div>
  );
});

interface MissingRowProps {
  row: MissingTrackRow;
  isCurrent: boolean;
  visibleColumns: ColumnConfig[];
  presence: TrackRowActionPresence;
  maxPopularity: number;
  handlers: React.RefObject<TrackRowHandlers>;
}

/** A tracklist entry with no library copy. Same columns as TrackRow so it
 *  lines up, but read-only: no like control, no file facts, no selection —
 *  a `role="option"` that is `aria-disabled`, outside the keyboard cursor. */
const MissingRow = memo(function MissingRow({ row, isCurrent, visibleColumns, presence, maxPopularity, handlers }: MissingRowProps) {
  const t = row.track;
  function renderCell(col: ColumnConfig) {
    switch (col.id) {
      case "num":
        return <span key="num" className="col-num">{row.number ?? ""}</span>;
      case "title":
        return (
          <span key="title" className="col-title">
            <span className="col-title-main">
              <span className="col-title-text">{t.title}</span>
              <span className="track-missing-badge">Not in library</span>
            </span>
            <RowHoverActions
              onPlay={() => handlers.current.playMissing?.(t)}
              onEnqueue={() => handlers.current.enqueueMissing?.(t)}
              onStartRadio={presence.startRadioMissing ? () => handlers.current.startRadioMissing?.(t) : undefined}
              onDetails={presence.locateMissing ? () => handlers.current.locateMissing?.(t) : undefined}
              onDownload={presence.downloadMissing ? () => handlers.current.downloadMissing?.(t) : undefined}
            />
          </span>
        );
      case "artist":
        return <span key="artist" className="col-artist">{t.artist_name ?? ""}</span>;
      case "album":
        return <span key="album" className="col-album">{t.album_title ?? ""}</span>;
      case "popularity": {
        const pct = (row.popularity && maxPopularity > 0) ? (row.popularity / maxPopularity) * 100 : 0;
        return (
          <span key="popularity" className="col-popularity">
            {row.popularity ? (
              <>
                <span className="popularity-fill" style={{ width: `${pct}%` }} />
                <span className="popularity-count">{formatCompactCount(row.popularity)}</span>
              </>
            ) : null}
          </span>
        );
      }
      default:
        // Like, duration, file facts: nothing to show for a track not on disk.
        return <span key={col.id} className={`col-${col.id}`} />;
    }
  }

  return (
    <div
      role="option"
      aria-disabled="true"
      aria-selected={false}
      className={`track-row track-row--missing${isCurrent ? " playing" : ""}`}
      title="Not in your library — plays from your other sources"
      onDoubleClick={() => handlers.current.playMissing?.(t)}
      onContextMenu={(e) => { e.preventDefault(); handlers.current.missingContextMenu?.(e, t); }}
    >
      {visibleColumns.map(col => renderCell(col))}
    </div>
  );
});
