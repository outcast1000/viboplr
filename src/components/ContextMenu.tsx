import type { Track } from "../types";

interface ContextMenuProps {
  x: number;
  y: number;
  track: Track;
  subsonic: boolean;
  onPlayNext: (track: Track) => void;
  onAddToQueue: (track: Track) => void;
  onShowInFolder: () => void;
  onClose: () => void;
}

export function ContextMenu({
  x, y, track, subsonic,
  onPlayNext, onAddToQueue, onShowInFolder, onClose,
}: ContextMenuProps) {
  return (
    <div
      className="context-menu"
      style={{ top: y, left: x }}
    >
      <div className="context-menu-item" onClick={() => { onPlayNext(track); onClose(); }}>
        Play Next
      </div>
      <div className="context-menu-item" onClick={() => { onAddToQueue(track); onClose(); }}>
        Add to Queue
      </div>
      {!subsonic && (
        <div className="context-menu-item" onClick={onShowInFolder}>
          Open Containing Folder
        </div>
      )}
      {subsonic && (
        <div className="context-menu-item" style={{ color: "var(--text-secondary)", cursor: "default" }}>
          Server track
        </div>
      )}
    </div>
  );
}
