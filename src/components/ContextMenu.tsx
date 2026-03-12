import { openUrl } from "@tauri-apps/plugin-opener";
import { artistSearchProviders, albumSearchProviders, trackSearchProviders } from "../searchProviders";
import { IconPlay, IconEnqueue, IconFolder } from "./Icons";

export type ContextMenuTarget =
  | { kind: "track"; trackId: number; subsonic: boolean; title: string; artistName: string | null }
  | { kind: "album"; albumId: number; title: string; artistName: string | null }
  | { kind: "artist"; artistId: number; name: string };

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

  const searchItems = target.kind === "artist"
    ? artistSearchProviders.map((p) => ({ label: p.label, icon: p.icon, url: p.buildUrl({ name: target.name }) }))
    : target.kind === "album"
    ? albumSearchProviders.map((p) => ({ label: p.label, icon: p.icon, url: p.buildUrl({ title: target.title, artistName: target.artistName ?? undefined }) }))
    : trackSearchProviders.map((p) => ({ label: p.label, icon: p.icon, url: p.buildUrl({ title: target.title, artistName: target.artistName ?? undefined }) }));

  return (
    <div
      className="context-menu"
      style={{ top: menu.y, left: menu.x }}
    >
      <div className="context-menu-item" onClick={() => { onPlay(); onClose(); }}>
        <IconPlay size={14} /><span>Play</span>
      </div>
      <div className="context-menu-item" onClick={() => { onEnqueue(); onClose(); }}>
        <IconEnqueue size={14} /><span>Enqueue</span>
      </div>
      {target.kind === "track" && !target.subsonic && (
        <div className="context-menu-item" onClick={onShowInFolder}>
          <IconFolder size={14} /><span>Locate File</span>
        </div>
      )}
      <div className="context-menu-separator" />
      {searchItems.map((item) => (
        <div key={item.label} className="context-menu-item" onClick={() => { openUrl(item.url); onClose(); }}>
          {item.icon}<span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}
