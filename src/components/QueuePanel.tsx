import { useState, useRef, useEffect, useCallback } from "react";
import type { QueueTrack } from "../types";
import type { PlaylistContext } from "../hooks/useQueue";
import { formatDuration } from "../utils";
import { queueItemLocalThumb, type ThumbInfo } from "../mainPlaylist";
import { extractDominantColor, type RGB } from "../utils/extractDominantColor";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import { resolveTrackImage } from "../utils/trackImage";
import { useImageCache } from "../hooks/useImageCache";
import { useFlipList } from "../hooks/useFlipList";
import { useQueueVideoFrames, shelfVideoKey } from "../hooks/useShelfVideoFrames";
import { SpinningDisc } from "./SpinningDisc";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { showNativeMenu, type MenuItemSpec } from "../nativeMenu";
import "./QueuePanel.css";

export interface PendingEnqueue {
  all: QueueTrack[];
  duplicates: QueueTrack[];
  unique: QueueTrack[];
}

function formatTotalDuration(tracks: QueueTrack[]): string {
  const totalSecs = tracks.reduce((sum, t) => sum + (t.duration_secs ?? 0), 0);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatPlaylistSource(source: string | null | undefined): string | null {
  if (!source) return null;
  const s = source.toLowerCase().trim();
  if (!s) return null;
  const known: Record<string, string> = {
    album: "Playing from album",
    artist: "Playing from artist",
    tag: "Playing from tag",
    playlist: "Playing from playlist",
  };
  return known[s] ?? `Playing from ${s}`;
}

function computeIndexSelection(
  current: Set<number>,
  clickedIndex: number,
  lastIndex: number | null,
  meta: boolean,
  shift: boolean,
): Set<number> {
  if (shift) {
    const start = lastIndex ?? 0;
    const lo = Math.min(start, clickedIndex);
    const hi = Math.max(start, clickedIndex);
    const range = new Set(Array.from({ length: hi - lo + 1 }, (_, k) => lo + k));
    if (meta) {
      const merged = new Set(current);
      for (const idx of range) merged.add(idx);
      return merged;
    }
    return range;
  }
  if (meta) {
    const next = new Set(current);
    if (next.has(clickedIndex)) {
      next.delete(clickedIndex);
    } else {
      next.add(clickedIndex);
    }
    return next;
  }
  return new Set([clickedIndex]);
}

interface QueuePanelProps {
  queue: QueueTrack[];
  queueIndex: number;
  queuePanelRef: React.RefObject<HTMLDivElement | null>;
  playlistContext: PlaylistContext | null;
  pendingEnqueue: PendingEnqueue | null;
  onAllowAll: () => void;
  onSkipDuplicates: () => void;
  onCancelEnqueue: () => void;
  onPlay: (track: QueueTrack, index: number) => void;
  onRemove: (index: number) => void;
  onLocateTrack?: (track: QueueTrack) => void;
  onMoveMultiple: (indices: number[], targetIndex: number) => void;
  onClear: () => void;
  onSaveAsM3U: () => void;
  onSaveToPlaylists: () => void;
  onExportAsMixtape: () => void;
  onEditPlaylist: () => void;
  onLoadPlaylist: () => void;
  onContextMenu: (e: React.MouseEvent, indices: number[]) => void;
  onToggleLike?: (track: QueueTrack) => void;
  onToggleDislike?: (track: QueueTrack) => void;
  externalDropTarget: number | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onResizeWidth: (width: number) => void;
  isPlaying?: boolean;
  debugMode?: boolean;
  mainPlaylistDir: string | null;
  thumbInfo: Record<string, ThumbInfo>;
  resolvingStatus?: { key: string; error: string | null; trying: string | null } | null;
  resolveFailures?: Record<string, string>;
}

const AUTO_APPROVE_SECS = 10;

function QueueItemThumb({ localThumb, fallback }: { localThumb: string | null; fallback: string | null }) {
  const [failedSrcs, setFailedSrcs] = useState<Set<string>>(new Set());

  const src = [localThumb, fallback].find(s => s && !failedSrcs.has(s)) ?? null;

  if (!src) {
    return (
      <div className="queue-item-thumb queue-item-thumb-placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </div>
    );
  }

  return (
    <img
      key={src}
      className="queue-item-thumb"
      src={src}
      onError={() => setFailedSrcs(prev => new Set(prev).add(src))}
      alt=""
    />
  );
}

export function QueuePanel({
  queue, queueIndex, queuePanelRef, playlistContext,
  pendingEnqueue, onAllowAll, onSkipDuplicates, onCancelEnqueue,
  onPlay, onRemove: _onRemove, onLocateTrack, onMoveMultiple, onClear, onSaveAsM3U, onSaveToPlaylists, onExportAsMixtape, onEditPlaylist, onLoadPlaylist, onContextMenu, onToggleLike, onToggleDislike,
  externalDropTarget,
  collapsed, onToggleCollapsed, onResizeWidth, isPlaying, debugMode,
  mainPlaylistDir, thumbInfo, resolvingStatus, resolveFailures,
}: QueuePanelProps) {
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_APPROVE_SECS);
  const [tooltip, setTooltip] = useState<{ track: QueueTrack; anchorX: number; anchorY: number } | null>(null);
  const [contextInfoAnchor, setContextInfoAnchor] = useState<{ x: number; y: number } | null>(null);
  const [contextInfoPos, setContextInfoPos] = useState<{ left: number; top: number } | null>(null);
  const contextInfoRef = useRef<HTMLDivElement>(null);
  const [coverColor, setCoverColor] = useState<RGB | null>(null);
  const lastClickedIndexRef = useRef<number | null>(null);
  const dragIndicesRef = useRef<number[] | null>(null);
  const dropTargetRef = useRef<number | null>(null);
  const didDragRef = useRef(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null);
  const queueListRef = useRef<HTMLDivElement>(null);

  // Physical reorder/insert/remove settling for the queue list.
  useFlipList(queueListRef);

  useEffect(() => {
    if (!tooltip || !tooltipRef.current) { setTooltipPos(null); return; }
    const el = tooltipRef.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let left = tooltip.anchorX;
    let top = tooltip.anchorY - rect.height - 6;
    if (top < pad) top = tooltip.anchorY + 30;
    if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - pad - rect.width;
    if (left < pad) left = pad;
    if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - pad - rect.height;
    setTooltipPos({ left, top });
  }, [tooltip]);

  const openSaveMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const specs: MenuItemSpec[] = [
      { kind: "item", text: "Save as Playlist", action: onSaveToPlaylists },
      { kind: "item", text: "Export as M3U", action: onSaveAsM3U },
      { kind: "item", text: "Export as Mixtape", action: onExportAsMixtape },
    ];
    showNativeMenu(rect.left, rect.bottom, specs).catch((err) =>
      console.error("Failed to show save playlist menu:", err)
    );
  }, [onSaveToPlaylists, onSaveAsM3U, onExportAsMixtape]);

  useEffect(() => {
    if (!contextInfoAnchor || !contextInfoRef.current) { setContextInfoPos(null); return; }
    const el = contextInfoRef.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let left = contextInfoAnchor.x;
    let top = contextInfoAnchor.y + 4;
    if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - pad - rect.width;
    if (left < pad) left = pad;
    if (top + rect.height > window.innerHeight - pad) top = contextInfoAnchor.y - rect.height - 4;
    if (top < pad) top = pad;
    setContextInfoPos({ left, top });
  }, [contextInfoAnchor]);

  useEffect(() => {
    if (!contextInfoAnchor) return;
    const handle = (e: MouseEvent) => {
      if (contextInfoRef.current && !contextInfoRef.current.contains(e.target as Node)) {
        setContextInfoAnchor(null);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [contextInfoAnchor]);

  // Clear selection when queue changes (add/remove/reorder)
  useEffect(() => { setSelectedIndices(new Set()); }, [queue]);

  // Extract dominant color from cover image
  useEffect(() => {
    const imagePath = playlistContext?.imagePath;
    if (!imagePath) {
      setCoverColor(null);
      return;
    }
    const src = resolveImageUrl(imagePath);
    if (!src) {
      setCoverColor(null);
      return;
    }
    let canceled = false;
    extractDominantColor(src).then(result => {
      if (!canceled) setCoverColor(result);
    });
    return () => { canceled = true; };
  }, [playlistContext?.imagePath]);

  // Image resolution for queue items missing an explicit image_url, priority
  // video frame -> album -> artist. Album/artist go through useImageCache, which
  // fetches on a cache miss AND refreshes this view when the backend emits
  // {album,artist}-image-ready. Video first-frames go through the shared
  // VideoFrameQueue: useQueueVideoFrames extracts on demand and re-renders on
  // completion. So unlike the previous cache-only pass, a queue thumbnail now
  // populates as soon as the image lands instead of staying a placeholder.
  const albumImages = useImageCache("album");
  const artistImages = useImageCache("artist");
  const videoFrames = useQueueVideoFrames(queue);

  const getTrackImage = useCallback((t: QueueTrack): string | null =>
    resolveTrackImage(t, {
      albumImageFor: albumImages.getImage,
      artistImageFor: artistImages.getImage,
      // Video frame URLs from the queue are already converted — passed verbatim.
      videoFrame: videoFrames[shelfVideoKey(t.artist_name, t.title)] ?? null,
    }),
  [videoFrames, albumImages, artistImages]);

  // Scroll to currently playing track when panel opens or un-collapses
  useEffect(() => {
    if (!collapsed && queueIndex >= 0 && queuePanelRef.current) {
      requestAnimationFrame(() => {
        const list = queuePanelRef.current?.querySelector(".queue-list");
        const item = list?.querySelector(`[data-queue-index="${queueIndex}"]`) as HTMLElement | undefined;
        item?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
  }, [collapsed]);

  // Auto-approve countdown for duplicate warning
  useEffect(() => {
    if (!pendingEnqueue) { setCountdown(AUTO_APPROVE_SECS); return; }
    setCountdown(AUTO_APPROVE_SECS);
    const interval = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) { clearInterval(interval); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [pendingEnqueue]);

  useEffect(() => {
    if (pendingEnqueue && countdown === 0) onAllowAll();
  }, [countdown, pendingEnqueue]);

  function handleClick(e: React.MouseEvent, _track: QueueTrack, index: number) {
    // Ignore click if we just finished a drag
    if (didDragRef.current) return;

    const meta = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;

    const newSelection = computeIndexSelection(
      selectedIndices, index,
      lastClickedIndexRef.current, meta, shift,
    );
    setSelectedIndices(newSelection);
    lastClickedIndexRef.current = index;
  }

  function handleDoubleClick(track: QueueTrack, index: number) {
    onPlay(track, index);
  }

  function findQueueIndex(el: Element | null): number | null {
    while (el) {
      const idx = el.getAttribute("data-queue-index");
      if (idx !== null) return parseInt(idx, 10);
      el = el.parentElement;
    }
    return null;
  }

  function handleMouseDown(e: React.MouseEvent, index: number) {
    if (e.button !== 0) return;

    // Determine which indices we're dragging
    let indices: number[];
    if (selectedIndices.has(index) && selectedIndices.size > 1) {
      indices = [...selectedIndices].sort((a, b) => a - b);
    } else {
      indices = [index];
    }
    dragIndicesRef.current = indices;
    didDragRef.current = false;

    const startX = e.clientX;
    const startY = e.clientY;

    function showGhost(x: number, y: number) {
      if (!ghostRef.current) {
        const ghost = document.createElement("div");
        ghost.className = "queue-drag-ghost";
        ghost.textContent = `${indices.length} track${indices.length > 1 ? "s" : ""}`;
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
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!didDragRef.current && Math.abs(dx) + Math.abs(dy) < 5) return;

      if (!didDragRef.current) {
        didDragRef.current = true;
        setIsDragging(true);
        if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
        setTooltip(null);
        setTooltipPos(null);
      }

      showGhost(ev.clientX, ev.clientY);

      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const overIndex = target ? findQueueIndex(target) : null;
      if (overIndex !== null) {
        const el = target!.closest("[data-queue-index]") as HTMLElement | null;
        if (el) {
          const rect = el.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          const dt = ev.clientY < midY ? overIndex : overIndex + 1;
          dropTargetRef.current = dt;
          setDropTarget(dt);
        }
      } else {
        dropTargetRef.current = null;
        setDropTarget(null);
      }
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      removeGhost();

      if (didDragRef.current && dragIndicesRef.current && dropTargetRef.current !== null) {
        onMoveMultiple(dragIndicesRef.current, dropTargetRef.current);
      }

      dragIndicesRef.current = null;
      dropTargetRef.current = null;
      setDropTarget(null);
      setIsDragging(false);
      // Prevent the click handler from firing after drag
      setTimeout(() => { didDragRef.current = false; }, 0);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  function handleContextMenu(e: React.MouseEvent, index: number) {
    e.preventDefault();
    if (selectedIndices.size > 1 && selectedIndices.has(index)) {
      onContextMenu(e, [...selectedIndices].sort((a, b) => a - b));
    } else {
      setSelectedIndices(new Set([index]));
      lastClickedIndexRef.current = index;
      onContextMenu(e, [index]);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setSelectedIndices(new Set());
    } else if (e.key === "a" && (e.metaKey || e.ctrlKey) && queue.length > 0) {
      if ((e.target as HTMLElement)?.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
      setSelectedIndices(new Set(Array.from({ length: queue.length }, (_, i) => i)));
    }
  }

  const [resizing, setResizing] = useState(false);

  function handleResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    setResizing(true);
    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(600, window.innerWidth - ev.clientX));
      onResizeWidth(newWidth);
    };
    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      setResizing(false);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  // Derived values for banner rendering
  const eyebrow = formatPlaylistSource(playlistContext?.source);
  const gradientStop = coverColor
    ? `${coverColor.r}, ${coverColor.g}, ${coverColor.b}`
    : "var(--accent-rgb)";
  const bannerStyle: { background: string } = {
    background: `linear-gradient(90deg, rgba(${gradientStop}, 0.45) 0%, rgba(${gradientStop}, 0.08) 60%, transparent 100%)`,
  };
  const hasInfoContent = !!(
    playlistContext?.source ||
    playlistContext?.description ||
    (playlistContext?.metadata && Object.keys(playlistContext.metadata).length > 0)
  );

  return (
    <aside className={`queue-panel${collapsed ? " collapsed" : ""}`} ref={queuePanelRef} tabIndex={-1} onKeyDown={handleKeyDown}>
      {!collapsed && <div className={`queue-resize-handle${resizing ? " active" : ""}`} onMouseDown={handleResizeMouseDown} />}
      {collapsed ? (
        <div className="queue-collapsed-strip" onClick={onToggleCollapsed}>
          <span className="queue-collapsed-label">Playlist</span>
          <span className="queue-collapsed-count">{queue.length} track{queue.length !== 1 ? "s" : ""}</span>
          {queue.length > 0 && <span className="queue-collapsed-duration">{formatTotalDuration(queue)}</span>}
        </div>
      ) : (
      <>
      <div className="queue-header">
        <span className="queue-title">Playlist</span>
        <div className="queue-header-actions">
          <button className="g-btn g-btn-sm" onClick={onLoadPlaylist} title="Load playlist" dangerouslySetInnerHTML={{ __html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' }} />
          <div className="queue-save-wrapper">
            <button className="g-btn g-btn-sm queue-save-btn" onClick={openSaveMenu} title="Save playlist">
              <span dangerouslySetInnerHTML={{ __html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>' }} />
              <span className="queue-save-caret">&#9662;</span>
            </button>
          </div>
          <button className="g-btn g-btn-sm" onClick={onEditPlaylist} title="Edit playlist" dangerouslySetInnerHTML={{ __html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>' }} />
          <button className="g-btn g-btn-sm" onClick={onClear} title="Clear playlist" dangerouslySetInnerHTML={{ __html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' }} />
        </div>
      </div>
      {pendingEnqueue && (
        <div className="queue-duplicate-banner">
          <span className="queue-duplicate-text">
            {pendingEnqueue.duplicates.length} duplicate{pendingEnqueue.duplicates.length !== 1 ? "s" : ""} found
          </span>
          <div className="queue-duplicate-actions">
            <button className="queue-duplicate-btn" onClick={onAllowAll}>
              Add all ({countdown}s)
            </button>
            {pendingEnqueue.unique.length > 0 && (
              <button className="queue-duplicate-btn queue-duplicate-btn-primary" onClick={onSkipDuplicates}>
                Add {pendingEnqueue.unique.length} new
              </button>
            )}
            <button className="queue-duplicate-btn" onClick={onCancelEnqueue}>Cancel</button>
          </div>
        </div>
      )}
      {playlistContext && queue.length > 0 && (
        <div className="queue-context-banner" style={bannerStyle}>
          <div className="queue-context-cover">
            {playlistContext.imagePath ? (
              <img
                src={resolveImageUrl(playlistContext.imagePath)}
                alt=""
                onError={e => { e.currentTarget.style.display = "none"; }}
              />
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18V5l12-2v13"/>
                <circle cx="6" cy="18" r="3"/>
                <circle cx="18" cy="16" r="3"/>
              </svg>
            )}
          </div>
          {eyebrow && <div className="queue-context-eyebrow">{eyebrow}</div>}
          <div className="queue-context-text">
            <div className="queue-context-name">{playlistContext.name}</div>
            <div className="queue-context-meta">
              {queue.length} track{queue.length !== 1 ? "s" : ""} · {formatTotalDuration(queue)}
            </div>
          </div>
          {hasInfoContent && (
            <button
              className="queue-context-info-btn"
              aria-expanded={contextInfoAnchor !== null}
              onClick={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setContextInfoAnchor(prev => prev ? null : { x: rect.left, y: rect.bottom });
              }}
              title="Playlist info"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            </button>
          )}
        </div>
      )}
      <div className="queue-list" ref={queueListRef}>
        {queue.map((t, i) => (
          <div
            key={t.key}
            data-queue-index={i}
            data-flip-key={t.key}
            className={
              `queue-item${i === queueIndex ? ` queue-current${isPlaying ? "" : " paused"}` : ""}${selectedIndices.has(i) ? " selected" : ""}`
              + `${(dropTarget === i || externalDropTarget === i) ? " drop-above" : ""}`
              + `${((dropTarget === i + 1 || externalDropTarget === i + 1) && i === queue.length - 1) ? " drop-below" : ""}`
              + `${isDragging && dragIndicesRef.current?.includes(i) ? " dragging" : ""}`
            }
            onMouseDown={(e) => handleMouseDown(e, i)}
            onClick={(e) => handleClick(e, t, i)}
            onDoubleClick={() => handleDoubleClick(t, i)}
            onContextMenu={(e) => handleContextMenu(e, i)}
          >
            <div className="queue-item-content">
              <div className="queue-item-art-wrapper">
                <QueueItemThumb
                  localThumb={resolveImageUrl(queueItemLocalThumb({
                    mainPlaylistDir,
                    uri: t.path,
                    thumbInfo,
                  })) ?? null}
                  fallback={getTrackImage(t)}
                />
                {onToggleLike && (
                  <LikeDislikeButtons
                    liked={t.liked}
                    onToggleLike={() => onToggleLike(t)}
                    onToggleDislike={onToggleDislike ? () => onToggleDislike(t) : undefined}
                    variant="overlay"
                    size={14}
                  />
                )}
              </div>
              <div
                className="queue-item-info"
                onMouseEnter={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  tooltipTimerRef.current = setTimeout(() => setTooltip({ track: t, anchorX: rect.left, anchorY: rect.top }), 400);
                }}
                onMouseLeave={() => { if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current); setTooltip(null); setTooltipPos(null); }}
              >
                <div className="queue-item-line1">
                  {resolvingStatus?.key === t.key ? (
                    <span
                      className="queue-item-resolving-icon"
                      title={resolvingStatus.error ? `${resolvingStatus.error} · Trying ${resolvingStatus.trying}…` : `Trying ${resolvingStatus.trying}…`}
                    />
                  ) : i === queueIndex ? (
                    <SpinningDisc size={13} playing={!!isPlaying} />
                  ) : null}
                  <span className="queue-item-title">{t.title}</span>
                  <span className="queue-item-duration">{formatDuration(t.duration_secs)}</span>
                </div>
                <div className="queue-item-line2">
                  <span className="queue-item-artist">{t.artist_name || "Unknown"}</span>
                  {t.album_title && <span className="queue-item-album">{t.album_title}</span>}
                </div>
                {resolveFailures?.[t.key] && resolvingStatus?.key !== t.key ? (
                  <div className="queue-item-status queue-item-status-failed">
                    <svg className="queue-resolving-fail-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    <span className="queue-resolving-error">Couldn't play · {resolveFailures[t.key]}</span>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="row-hover-actions">
              {i !== queueIndex && (
                <button
                  className="row-hover-action row-hover-action--play"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onPlay(t, i); }}
                  title="Play"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
                </button>
              )}
              {onLocateTrack && (
                <button
                  className="row-hover-action"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onLocateTrack(t); }}
                  title="Details"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                </button>
              )}
            </div>
          </div>
        ))}
        {queue.length === 0 && (
          <div className={`queue-empty${externalDropTarget !== null ? " drop-highlight" : ""}`}>
            {externalDropTarget !== null ? "Drop here to add" : "Playlist is empty"}
          </div>
        )}
      </div>
      {queue.length > 0 && !playlistContext && (
        <div className="queue-info-bar">
          <span className="queue-info-stats">
            {queue.length} track{queue.length !== 1 ? "s" : ""} &middot; {formatTotalDuration(queue)}
          </span>
        </div>
      )}
      </>
      )}
      {tooltip && (() => {
        const t = tooltip.track;
        return (
          <div
            ref={tooltipRef}
            className={`ds-tooltip${tooltipPos ? " visible" : ""}`}
            style={tooltipPos ?? { left: tooltip.anchorX, top: tooltip.anchorY, visibility: "hidden" }}
          >
            <div className="ds-tooltip-title">{t.title}</div>
            {debugMode ? (
              <div className="ds-tooltip-rows">
                {([
                  ["key", t.key], ["path", t.path],
                  ["artist", t.artist_name], ["album", t.album_title],
                  ["duration_secs", t.duration_secs], ["format", t.format],
                  ["liked", t.liked], ["image_url", t.image_url],
                ] as [string, unknown][]).map(([k, v]) => (
                  <div key={k} className="ds-tooltip-row">
                    <span className="ds-tooltip-key">{k}</span>
                    <span className="ds-tooltip-val">{v != null ? String(v) : "(none)"}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ds-tooltip-body">
                {[
                  [t.artist_name, t.album_title].filter(Boolean).join(" — "),
                  t.format?.toUpperCase(),
                ].filter(Boolean).join("\n")}
              </div>
            )}
          </div>
        );
      })()}
      {contextInfoAnchor && playlistContext && (
        <div
          ref={contextInfoRef}
          className={`ds-tooltip${contextInfoPos ? " visible" : ""}`}
          style={{ ...(contextInfoPos ?? { left: contextInfoAnchor.x, top: contextInfoAnchor.y, visibility: "hidden" as const }), pointerEvents: "auto" }}
        >
          <div className="ds-tooltip-title">{playlistContext.name}</div>
          <div className="ds-tooltip-rows">
            {playlistContext.source && (
              <div className="ds-tooltip-row">
                <span className="ds-tooltip-key">source</span>
                <span className="ds-tooltip-val">{playlistContext.source}</span>
              </div>
            )}
            {playlistContext.metadata && Object.entries(playlistContext.metadata).map(([key, value]) => (
              <div className="ds-tooltip-row" key={key}>
                <span className="ds-tooltip-key">{key}</span>
                <span className="ds-tooltip-val">{value}</span>
              </div>
            ))}
            {playlistContext.description && (
              <div className="ds-tooltip-row">
                <span className="ds-tooltip-key">description</span>
                <span className="ds-tooltip-val ds-tooltip-val--desc">{playlistContext.description.length > 200 ? playlistContext.description.slice(0, 200) + "…" : playlistContext.description}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
