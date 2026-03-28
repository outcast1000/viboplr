import { openUrl } from "@tauri-apps/plugin-opener";
import type { SearchProviderConfig } from "../searchProviders";
import { getProvidersForContext, buildSearchUrl, getDomainFromUrl } from "../searchProviders";
import { IconPlay, IconEnqueue, IconFolder, IconGoogle, IconLastfm, IconX, IconYoutube, IconGenius, IconInfo, IconTrash } from "./Icons";
import { useEffect, useRef, useState, type ReactNode } from "react";

export type ContextMenuTarget =
  | { kind: "track"; trackId: number; subsonic: boolean; title: string; artistName: string | null }
  | { kind: "album"; albumId: number; title: string; artistName: string | null }
  | { kind: "artist"; artistId: number; name: string }
  | { kind: "multi-track"; trackIds: number[] }
  | { kind: "queue-multi"; indices: number[] };

export interface ContextMenuState {
  x: number;
  y: number;
  target: ContextMenuTarget;
}

interface ContextMenuProps {
  menu: ContextMenuState;
  providers: SearchProviderConfig[];
  onPlay: () => void;
  onEnqueue: () => void;
  onShowInFolder: () => void;
  onWatchOnYoutube?: () => void;
  onShowProperties?: () => void;
  onDelete?: () => void;
  onRemoveFromQueue?: () => void;
  onMoveToTop?: () => void;
  onMoveToBottom?: () => void;
  onLocateTrack?: () => void;
  onDownload?: (destCollectionId: number) => void;
  onUpgradeViaTidal?: () => void;
  localCollections?: { id: number; name: string }[];
  onClose: () => void;
}

const BUILTIN_ICONS: Record<string, (p: { size?: number }) => ReactNode> = {
  google: IconGoogle,
  lastfm: IconLastfm,
  x: IconX,
  youtube: IconYoutube,
  genius: IconGenius,
};

function useClampedPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clampedX = x + rect.width > window.innerWidth ? window.innerWidth - rect.width - 4 : x;
    const clampedY = y + rect.height > window.innerHeight ? window.innerHeight - rect.height - 4 : y;
    setPos({ x: Math.max(0, clampedX), y: Math.max(0, clampedY) });
  }, [x, y]);

  return { ref, pos };
}

function ProviderIcon({ provider }: { provider: SearchProviderConfig }) {
  const [imgError, setImgError] = useState(false);

  if (provider.builtinIcon && BUILTIN_ICONS[provider.builtinIcon]) {
    const Icon = BUILTIN_ICONS[provider.builtinIcon];
    return <>{Icon({ size: 14 })}</>;
  }

  const url = provider.artistUrl || provider.albumUrl || provider.trackUrl || "";
  const domain = getDomainFromUrl(url);

  if (domain && !imgError) {
    return (
      <img
        className="provider-icon-img"
        src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
        width={14}
        height={14}
        onError={() => setImgError(true)}
        alt=""
      />
    );
  }

  return (
    <span className="provider-icon-fallback">
      {provider.name[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

export function ContextMenu({
  menu, providers, onPlay, onEnqueue, onShowInFolder, onWatchOnYoutube, onShowProperties,
  onDelete, onRemoveFromQueue, onMoveToTop, onMoveToBottom, onLocateTrack, onDownload, onUpgradeViaTidal, localCollections, onClose,
}: ContextMenuProps) {
  const { target } = menu;
  const { ref, pos } = useClampedPosition(menu.x, menu.y);

  const isMulti = target.kind === "multi-track";
  const isQueue = target.kind === "queue-multi";
  const context = isMulti || isQueue ? "track" : target.kind;
  const contextProviders = isMulti || isQueue ? [] : getProvidersForContext(providers, context);
  const urlKey = context === "artist" ? "artistUrl" : context === "album" ? "albumUrl" : "trackUrl";

  const params = isMulti || isQueue ? {} :
    target.kind === "artist"
      ? { artist: target.name }
      : { title: target.title, artist: target.artistName ?? undefined };

  const count = isQueue ? target.indices.length : isMulti ? target.trackIds.length : 1;

  if (isQueue) {
    return (
      <div ref={ref} className="context-menu" style={{ top: pos.y, left: pos.x }}>
        <div className="context-menu-item" onClick={() => { onPlay(); onClose(); }}>
          <IconPlay size={14} /><span>{count > 1 ? `Play ${count} tracks` : "Play"}</span>
        </div>
        {onRemoveFromQueue && (
          <div className="context-menu-item" onClick={() => { onRemoveFromQueue(); onClose(); }}>
            <IconFolder size={14} /><span>{count > 1 ? `Remove ${count} tracks` : "Remove"}</span>
          </div>
        )}
        {onMoveToTop && (
          <div className="context-menu-item" onClick={() => { onMoveToTop(); onClose(); }}>
            <IconEnqueue size={14} /><span>Move to top</span>
          </div>
        )}
        {onMoveToBottom && (
          <div className="context-menu-item" onClick={() => { onMoveToBottom(); onClose(); }}>
            <IconEnqueue size={14} /><span>Move to bottom</span>
          </div>
        )}
        {onLocateTrack && count === 1 && (
          <>
            <div className="context-menu-separator" />
            <div className="context-menu-item" onClick={() => { onLocateTrack(); onClose(); }}>
              <IconFolder size={14} /><span>Locate Track</span>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ top: pos.y, left: pos.x }}
    >
      <div className="context-menu-item" onClick={() => { onPlay(); onClose(); }}>
        <IconPlay size={14} /><span>{isMulti ? `Play ${target.trackIds.length} tracks` : "Play"}</span>
      </div>
      <div className="context-menu-item" onClick={() => { onEnqueue(); onClose(); }}>
        <IconEnqueue size={14} /><span>{isMulti ? `Enqueue ${target.trackIds.length} tracks` : "Enqueue"}</span>
      </div>
      {target.kind === "track" && !target.subsonic && (
        <div className="context-menu-item" onClick={onShowInFolder}>
          <IconFolder size={14} /><span>Locate File</span>
        </div>
      )}
      {target.kind === "track" && onWatchOnYoutube && (
        <div className="context-menu-item" onClick={() => { onWatchOnYoutube(); onClose(); }}>
          <IconYoutube size={14} /><span>Watch on YouTube</span>
        </div>
      )}
      {target.kind === "track" && onShowProperties && (
        <div className="context-menu-item" onClick={() => { onShowProperties(); onClose(); }}>
          <IconInfo size={14} /><span>Properties</span>
        </div>
      )}
      {onDelete && (target.kind === "track" && !target.subsonic || target.kind === "multi-track") && (
        <>
          <div className="context-menu-separator" />
          <div className="context-menu-item context-menu-item-danger" onClick={() => { onDelete(); onClose(); }}>
            <IconTrash size={14} /><span>{isMulti ? `Delete ${target.trackIds.length} tracks` : "Delete"}</span>
          </div>
        </>
      )}
      {target.kind === "track" && !target.subsonic && onUpgradeViaTidal && (
        <>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => { onUpgradeViaTidal(); onClose(); }}>
            <IconEnqueue size={14} /><span>Upgrade via TIDAL</span>
          </div>
        </>
      )}
      {target.kind === "track" && target.subsonic && onDownload && localCollections && localCollections.length > 0 && (
        <>
          <div className="context-menu-separator" />
          {localCollections.length === 1 ? (
            <div className="context-menu-item" onClick={() => { onDownload(localCollections[0].id); onClose(); }}>
              <IconFolder size={14} /><span>Download to {localCollections[0].name}</span>
            </div>
          ) : (
            <div className="context-menu-submenu">
              <div className="context-menu-item">
                <IconFolder size={14} /><span>Download to...</span>
              </div>
              <div className="context-menu-submenu-list">
                {localCollections.map(c => (
                  <div key={c.id} className="context-menu-item" onClick={() => { onDownload(c.id); onClose(); }}>
                    <span>{c.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {contextProviders.length > 0 && (
        <>
          <div className="context-menu-separator" />
          {contextProviders.map((provider) => {
            const template = provider[urlKey]!;
            const url = buildSearchUrl(template, params);
            return (
              <div key={provider.id} className="context-menu-item" onClick={() => { openUrl(url); onClose(); }}>
                <ProviderIcon provider={provider} />
                <span>Search on {provider.name}</span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
