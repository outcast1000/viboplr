export type ContextMenuTarget =
  | { kind: "track"; trackId: number; subsonic: boolean }
  | { kind: "album"; albumId: number }
  | { kind: "artist"; artistId: number };

export interface ContextMenuState {
  x: number;
  y: number;
  target: ContextMenuTarget;
}

interface ContextMenuProps {
  menu: ContextMenuState;
  onPlay: () => void;
  onEnqueue: () => void;
  onShowInFolder: () => void;
  onClose: () => void;
}

export function ContextMenu({
  menu, onPlay, onEnqueue, onShowInFolder, onClose,
}: ContextMenuProps) {
  const { target } = menu;
  return (
    <div
      className="context-menu"
      style={{ top: menu.y, left: menu.x }}
    >
      <div className="context-menu-item" onClick={() => { onPlay(); onClose(); }}>
        Play
      </div>
      <div className="context-menu-item" onClick={() => { onEnqueue(); onClose(); }}>
        Enqueue
      </div>
      {target.kind === "track" && !target.subsonic && (
        <div className="context-menu-item" onClick={onShowInFolder}>
          Locate File
        </div>
      )}
    </div>
  );
}
