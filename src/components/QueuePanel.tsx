import type { Track } from "../types";
import { formatDuration } from "../utils";

function formatTotalDuration(tracks: Track[]): string {
  const totalSecs = tracks.reduce((sum, t) => sum + (t.duration_secs ?? 0), 0);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

interface QueuePanelProps {
  queue: Track[];
  queueIndex: number;
  queuePanelRef: React.RefObject<HTMLDivElement | null>;
  dragIndexRef: React.MutableRefObject<number | null>;
  playlistName: string | null;
  onPlay: (track: Track, index: number) => void;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onClear: () => void;
  onClose: () => void;
  onSavePlaylist: () => void;
  onLoadPlaylist: () => void;
}

export function QueuePanel({
  queue, queueIndex, queuePanelRef, dragIndexRef, playlistName,
  onPlay, onRemove, onMove, onClear, onClose, onSavePlaylist, onLoadPlaylist,
}: QueuePanelProps) {
  return (
    <aside className="queue-panel" ref={queuePanelRef}>
      <div className="queue-header">
        <span className="queue-title">Playlist</span>
        <div className="queue-header-actions">
          <button className="ctrl-btn" onClick={onLoadPlaylist} title="Load playlist" dangerouslySetInnerHTML={{ __html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' }} />
          <button className="ctrl-btn" onClick={onSavePlaylist} title="Save playlist" dangerouslySetInnerHTML={{ __html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>' }} />
          <button className="ctrl-btn" onClick={onClear} title="Clear playlist" dangerouslySetInnerHTML={{ __html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' }} />
          <button className="ctrl-btn" onClick={onClose} title="Close">{"\u00D7"}</button>
        </div>
      </div>
      <div className="queue-list">
        {queue.map((t, i) => (
          <div
            key={`${t.id}-${i}`}
            className={`queue-item ${i === queueIndex ? "queue-current" : ""}`}
            draggable
            onDragStart={() => { dragIndexRef.current = i; }}
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={() => {
              if (dragIndexRef.current !== null && dragIndexRef.current !== i) {
                onMove(dragIndexRef.current, i);
              }
              dragIndexRef.current = null;
            }}
            onClick={() => onPlay(t, i)}
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
