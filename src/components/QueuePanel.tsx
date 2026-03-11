import type { Track } from "../types";

interface QueuePanelProps {
  queue: Track[];
  queueIndex: number;
  queuePanelRef: React.RefObject<HTMLDivElement | null>;
  dragIndexRef: React.MutableRefObject<number | null>;
  onPlay: (track: Track, index: number) => void;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onClear: () => void;
  onClose: () => void;
}

export function QueuePanel({
  queue, queueIndex, queuePanelRef, dragIndexRef,
  onPlay, onRemove, onMove, onClear, onClose,
}: QueuePanelProps) {
  return (
    <aside className="queue-panel" ref={queuePanelRef}>
      <div className="queue-header">
        <span className="queue-title">Queue</span>
        <div className="queue-header-actions">
          <button className="ctrl-btn" onClick={onClear} title="Clear queue">{"\uD83D\uDDD1"}</button>
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
          <div className="queue-empty">Queue is empty</div>
        )}
      </div>
    </aside>
  );
}
