import { openUrl } from "@tauri-apps/plugin-opener";
import type { DockSide, FitMode } from "../hooks/useVideoLayout";
import type { SearchProviderConfig } from "../searchProviders";
import { getProvidersForContext, buildSearchUrl, getDomainFromUrl } from "../searchProviders";
import { IconPlay, IconEnqueue, IconFolder, IconGoogle, IconLastfm, IconX, IconYoutube, IconGenius, IconInfo, IconTrash, IconRefresh } from "./Icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";
import "./ContextMenu.css";

export type ContextMenuTarget =
  | { kind: "track"; trackId: number; subsonic: boolean; title: string; artistName: string | null; external?: boolean }
  | { kind: "album"; albumId: number; title: string; artistName: string | null }
  | { kind: "artist"; artistId: number; name: string }
  | { kind: "multi-track"; trackIds: number[] }
  | { kind: "queue-multi"; indices: number[]; trackIds: number[]; firstTrack: { title: string; artistName: string | null; subsonic: boolean } }
  | { kind: "video"; dockSide: DockSide; fitMode: FitMode };

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
  onViewDetails?: () => void;
  onDelete?: () => void;
  onRefreshImage?: () => void;
  onRemoveFromQueue?: () => void;
  onMoveToTop?: () => void;
  onMoveToBottom?: () => void;
  onLocateTrack?: () => void;
  onDownload?: (destCollectionId: number) => void;
  localCollections?: { id: number; name: string }[];
  onBulkEdit?: () => void;
  onClose: () => void;
  pluginMenuItems?: PluginMenuItem[];
  onPluginAction?: (pluginId: string, actionId: string, target: PluginContextMenuTarget) => void;
  onSetDockSide?: (side: DockSide) => void;
  onSetFitMode?: (mode: FitMode) => void;
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

function toPluginTarget(target: ContextMenuTarget): PluginContextMenuTarget {
  switch (target.kind) {
    case "track": return { kind: "track", trackId: target.trackId, title: target.title, artistName: target.artistName ?? undefined, subsonic: target.subsonic };
    case "album": return { kind: "album", albumId: target.albumId, albumTitle: target.title, artistName: target.artistName ?? undefined };
    case "artist": return { kind: "artist", artistId: target.artistId, artistName: target.name };
    case "multi-track": return { kind: "multi-track", trackIds: target.trackIds };
    case "queue-multi":
      if (target.trackIds.length === 1) {
        return { kind: "track", trackId: target.trackIds[0], title: target.firstTrack.title, artistName: target.firstTrack.artistName ?? undefined, subsonic: target.firstTrack.subsonic };
      }
      return { kind: "multi-track", trackIds: target.trackIds };
    default: return { kind: "track" };
  }
}

export function ContextMenu({
  menu, providers, onPlay, onEnqueue, onShowInFolder, onWatchOnYoutube, onViewDetails,
  onDelete, onRefreshImage, onRemoveFromQueue, onMoveToTop, onMoveToBottom, onLocateTrack, onDownload, localCollections,
  onBulkEdit, onClose,
  pluginMenuItems, onPluginAction,
  onSetDockSide, onSetFitMode,
}: ContextMenuProps) {
  const { target } = menu;
  const { ref, pos } = useClampedPosition(menu.x, menu.y);

  if (target.kind === "video") {
    return (
      <div ref={ref} className="context-menu" style={{ top: pos.y, left: pos.x }}>
        <div className="context-menu-label">Fit Mode</div>
        {(["contain", "fit-width", "fit-height", "fill"] as FitMode[]).map(mode => (
          <div key={mode} className="context-menu-item" onClick={() => { onSetFitMode?.(mode); onClose(); }}>
            <span className="context-menu-check">{target.fitMode === mode ? "\u2713" : ""}</span>
            <span>{mode === "contain" ? "Contain" : mode === "fit-width" ? "Fit Width" : mode === "fit-height" ? "Fit Height" : "Fill"}</span>
          </div>
        ))}
        <div className="context-menu-separator" />
        <div className="context-menu-label">Dock Side</div>
        {(["top", "bottom", "left", "right"] as DockSide[]).map(side => (
          <div key={side} className="context-menu-item" onClick={() => { onSetDockSide?.(side); onClose(); }}>
            <span className="context-menu-check">{target.dockSide === side ? "\u2713" : ""}</span>
            <span>{side[0].toUpperCase() + side.slice(1)}</span>
          </div>
        ))}
      </div>
    );
  }

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
        {onDelete && (
          <>
            <div className="context-menu-separator" />
            <div className="context-menu-item context-menu-item-danger" onClick={() => { onDelete(); onClose(); }}>
              <IconTrash size={14} /><span>{count > 1 ? `Delete ${count} tracks` : "Delete"}</span>
            </div>
          </>
        )}
        {pluginMenuItems && pluginMenuItems.length > 0 && (() => {
          const pluginTargetKind = count === 1 ? "track" : "multi-track";
          const matching = pluginMenuItems.filter(item => item.targets.includes(pluginTargetKind as "track" | "album" | "artist" | "multi-track"));
          if (matching.length === 0) return null;
          return (
            <>
              <div className="context-menu-separator" />
              {matching.map((item) => (
                <div
                  key={`${item.pluginId}:${item.id}`}
                  className="context-menu-item"
                  onClick={() => {
                    onPluginAction?.(item.pluginId, item.id, toPluginTarget(target));
                    onClose();
                  }}
                >
                  <span>{item.label}</span>
                </div>
              ))}
            </>
          );
        })()}
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
      {(target.kind === "artist" || target.kind === "album") && onRefreshImage && (
        <div className="context-menu-item" onClick={() => { onRefreshImage(); onClose(); }}>
          <IconRefresh size={14} /><span>Refresh Image</span>
        </div>
      )}
      {isMulti && onBulkEdit && (
        <div className="context-menu-item" onClick={() => { onBulkEdit(); onClose(); }}>
          <IconInfo size={14} /><span>Edit Properties</span>
        </div>
      )}
      {target.kind === "track" && !target.subsonic && !target.external && (
        <div className="context-menu-item" onClick={onShowInFolder}>
          <IconFolder size={14} /><span>Open Containing Folder</span>
        </div>
      )}
      {target.kind === "track" && !target.external && onWatchOnYoutube && (
        <div className="context-menu-item" onClick={() => { onWatchOnYoutube(); onClose(); }}>
          <IconYoutube size={14} /><span>Find in YouTube</span>
        </div>
      )}
      {target.kind === "track" && !target.external && onViewDetails && (
        <div className="context-menu-item" onClick={() => { onViewDetails(); onClose(); }}>
          <IconInfo size={14} /><span>View Details</span>
        </div>
      )}
      {onDelete && (target.kind === "track" && !target.subsonic && !target.external || target.kind === "multi-track") && (
        <>
          <div className="context-menu-separator" />
          <div className="context-menu-item context-menu-item-danger" onClick={() => { onDelete(); onClose(); }}>
            <IconTrash size={14} /><span>{isMulti ? `Delete ${target.trackIds.length} tracks` : "Delete"}</span>
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
          <div className="context-menu-submenu">
            <div className="context-menu-item">
              <span>Search</span>
            </div>
            <div className="context-menu-submenu-list">
              {contextProviders.map((provider) => {
                const template = provider[urlKey]!;
                const url = buildSearchUrl(template, params);
                return (
                  <div key={provider.id} className="context-menu-item" onClick={() => { openUrl(url); onClose(); }}>
                    <ProviderIcon provider={provider} />
                    <span>{provider.name}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
      {pluginMenuItems && pluginMenuItems.length > 0 && (() => {
        const targetKind = target.kind as string;
        const matching = pluginMenuItems.filter(item => item.targets.includes(targetKind as "track" | "album" | "artist" | "multi-track"));
        if (matching.length === 0) return null;
        return (
          <>
            <div className="context-menu-separator" />
            {matching.map((item) => (
              <div
                key={`${item.pluginId}:${item.id}`}
                className="context-menu-item"
                onClick={() => {
                  onPluginAction?.(item.pluginId, item.id, toPluginTarget(target));
                  onClose();
                }}
              >
                <span>{item.label}</span>
              </div>
            ))}
          </>
        );
      })()}
    </div>
  );
}
