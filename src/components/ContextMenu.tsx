import { openUrl } from "@tauri-apps/plugin-opener";
import type { SearchProviderConfig } from "../searchProviders";
import { getProvidersForContext, buildSearchUrl, getDomainFromUrl } from "../searchProviders";
import { IconPlay, IconEnqueue, IconFolder, IconGoogle, IconLastfm, IconX, IconYoutube, IconGenius, IconInfo } from "./Icons";
import { useState, type ReactNode } from "react";

export type ContextMenuTarget =
  | { kind: "track"; trackId: number; subsonic: boolean; title: string; artistName: string | null }
  | { kind: "album"; albumId: number; title: string; artistName: string | null }
  | { kind: "artist"; artistId: number; name: string }
  | { kind: "multi-track"; trackIds: number[] };

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
  onClose: () => void;
}

const BUILTIN_ICONS: Record<string, (p: { size?: number }) => ReactNode> = {
  google: IconGoogle,
  lastfm: IconLastfm,
  x: IconX,
  youtube: IconYoutube,
  genius: IconGenius,
};

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
  menu, providers, onPlay, onEnqueue, onShowInFolder, onWatchOnYoutube, onShowProperties, onClose,
}: ContextMenuProps) {
  const { target } = menu;

  const isMulti = target.kind === "multi-track";
  const context = isMulti ? "track" : target.kind;
  const contextProviders = isMulti ? [] : getProvidersForContext(providers, context);
  const urlKey = context === "artist" ? "artistUrl" : context === "album" ? "albumUrl" : "trackUrl";

  const params = isMulti ? {} :
    target.kind === "artist"
      ? { artist: target.name }
      : { title: target.title, artist: target.artistName ?? undefined };

  return (
    <div
      className="context-menu"
      style={{ top: menu.y, left: menu.x }}
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
