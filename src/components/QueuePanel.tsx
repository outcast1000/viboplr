import { useState, useRef, useEffect } from "react";
import type { Track } from "../types";
import { formatDuration } from "../utils";

function formatTotalDuration(tracks: Track[]): string {
  const totalSecs = tracks.reduce((sum, t) => sum + (t.duration_secs ?? 0), 0);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
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
  queue: Track[];
  queueIndex: number;
  queuePanelRef: React.RefObject<HTMLDivElement | null>;
  playlistName: string | null;
  onPlay: (track: Track, index: number) => void;
  onRemove: (index: number) => void;
  onMoveMultiple: (indices: number[], targetIndex: number) => void;
  onClear: () => void;
  onClose: () => void;
  onSavePlaylist: () => void;
  onLoadPlaylist: () => void;
  onContextMenu: (e: React.MouseEvent, indices: number[]) => void;
}

export function QueuePanel({
  queue, queueIndex, queuePanelRef, playlistName,
  onPlay, onRemove, onMoveMultiple, onClear, onClose, onSavePlaylist, onLoadPlaylist, onContextMenu,
}: QueuePanelProps) {
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const lastClickedIndexRef = useRef<number | null>(null);
  const dragIndicesRef = useRef<number[] | null>(null);

  // Clear selection when queue changes (add/remove/reorder)
  useEffect(() => { setSelectedIndices(new Set()); }, [queue]);

  function handleClick(e: React.MouseEvent, track: Track, index: number) {
    const meta = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;

    const newSelection = computeIndexSelection(
      selectedIndices, index,
      lastClickedIndexRef.current, meta, shift,
    );
    setSelectedIndices(newSelection);
    lastClickedIndexRef.current = index;

    // Only play on plain click (no modifiers)
    if (!meta && !shift) {
      onPlay(track, index);
    }
  }

  function handleDragStart(e: React.DragEvent, index: number) {
    // If dragging a selected item, drag all selected; otherwise just the one
    if (selectedIndices.has(index) && selectedIndices.size > 1) {
      dragIndicesRef.current = [...selectedIndices].sort((a, b) => a - b);
    } else {
      dragIndicesRef.current = [index];
      setSelectedIndices(new Set([index]));
      lastClickedIndexRef.current = index;
    }
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // Determine if drop should be above or below this item
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const target = e.clientY < midY ? index : index + 1;
    setDropTarget(target);
  }

  function handleDragLeave() {
    setDropTarget(null);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    if (dragIndicesRef.current && dropTarget !== null) {
      onMoveMultiple(dragIndicesRef.current, dropTarget);
    }
    dragIndicesRef.current = null;
    setDropTarget(null);
  }

  function handleDragEnd() {
    dragIndicesRef.current = null;
    setDropTarget(null);
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
    }
  }

  return (
    <aside className="queue-panel" ref={queuePanelRef} tabIndex={-1} onKeyDown={handleKeyDown}>
      <div className="queue-header">
        <span className="queue-title">Playlist</span>
        <div className="queue-header-actions">
          <button className="ctrl-btn" onClick={onLoadPlaylist} title="Load playlist" dangerouslySetInnerHTML={{ __html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' }} />
          <button className="ctrl-btn" onClick={onSavePlaylist} title="Save playlist" dangerouslySetInnerHTML={{ __html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>' }} />
          <button className="ctrl-btn" onClick={onClear} title="Clear playlist" dangerouslySetInnerHTML={{ __html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' }} />
          <button className="ctrl-btn" onClick={onClose} title="Close">{"\u00D7"}</button>
        </div>
      </div>
      <div className="queue-list" onDragLeave={handleDragLeave}>
        {queue.map((t, i) => (
          <div
            key={`${t.id}-${i}`}
            className={
              `queue-item${i === queueIndex ? " queue-current" : ""}${selectedIndices.has(i) ? " selected" : ""}`
              + `${dropTarget === i ? " drop-above" : ""}${dropTarget === i + 1 && i === queue.length - 1 ? " drop-below" : ""}`
              + `${dragIndicesRef.current?.includes(i) ? " dragging" : ""}`
            }
            draggable
            onDragStart={(e) => handleDragStart(e, i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
            onClick={(e) => handleClick(e, t, i)}
            onContextMenu={(e) => handleContextMenu(e, i)}
          >
            <div className="queue-item-info">
              <span className="queue-item-title">{t.title}</span>
              <span className="queue-item-artist">{t.artist_name || "Unknown"}</span>
            </div>
            <span className="queue-item-duration">{formatDuration(t.duration_secs)}</span>
            <button
              className="queue-item-remove"
              onClick={(e) => { e.stopPropagation(); onRemove(i); }}
              title="Remove"
            >
              {"\u00D7"}
            </button>
          </div>
        ))}
        {queue.length === 0 && (
          <div className="queue-empty">Playlist is empty</div>
        )}
      </div>
      {queue.length > 0 && (
        <div className="queue-info-bar">
          {playlistName && <span className="queue-playlist-name">{playlistName} &middot; </span>}
          <span className="queue-info-stats">
            {queue.length} track{queue.length !== 1 ? "s" : ""} &middot; {formatTotalDuration(queue)}
          </span>
        </div>
      )}
    </aside>
  );
}
