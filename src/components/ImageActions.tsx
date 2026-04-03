import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SearchProviderConfig } from "../searchProviders";
import { buildSearchUrl, getDomainFromUrl } from "../searchProviders";
import { IconImage, IconRemoveImage, IconRefresh, IconGoogle, IconLastfm, IconX, IconYoutube, IconGenius } from "./Icons";
import type { ReactNode } from "react";

const BUILTIN_ICONS: Record<string, (p: { size?: number }) => ReactNode> = {
  google: IconGoogle,
  lastfm: IconLastfm,
  x: IconX,
  youtube: IconYoutube,
  genius: IconGenius,
};

function ProviderIcon({ provider }: { provider: SearchProviderConfig }) {
  if (provider.builtinIcon && BUILTIN_ICONS[provider.builtinIcon]) {
    const Icon = BUILTIN_ICONS[provider.builtinIcon];
    return <>{Icon({ size: 14 })}</>;
  }
  const url = provider.artistUrl || provider.albumUrl || provider.trackUrl || "";
  const domain = getDomainFromUrl(url);
  if (domain) {
    return <img className="provider-icon-img" src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`} width={14} height={14} alt="" />;
  }
  return <IconGoogle size={14} />;
}

interface ImageActionsProps {
  entityId: number;
  entityType: "artist" | "album" | "tag";
  entityName?: string;
  imagePath: string | null | undefined;
  providers?: SearchProviderConfig[];
  onImageSet: (id: number, path: string) => void;
  onImageRemoved: (id: number) => void;
  onRefresh?: () => void;
}

export function ImageActions({ entityId, entityType, entityName, imagePath, providers, onImageSet, onImageRemoved, onRefresh }: ImageActionsProps) {
  const [open_menu, setOpenMenu] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open_menu) return;
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpenMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open_menu]);

  const urlKey = entityType === "artist" ? "artistUrl" : entityType === "album" ? "albumUrl" : undefined;
  const activeProviders = providers && urlKey ? providers.filter(p => p[urlKey]) : [];

  return (
    <div className="artist-image-menu-wrapper" ref={wrapperRef}>
      <button
        className="artist-image-menu-trigger"
        onClick={(e) => { e.stopPropagation(); setOpenMenu(v => !v); }}
        title="Options"
      >
        &#x22EF;
      </button>
      {open_menu && (
        <div className="artist-image-menu-dropdown">
          <button
            onClick={async () => {
              setOpenMenu(false);
              const selected = await open({
                multiple: false,
                filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
              });
              if (selected) {
                const newPath = await invoke<string>("set_entity_image", {
                  kind: entityType,
                  id: entityId,
                  sourcePath: selected,
                });
                onImageSet(entityId, newPath);
              }
            }}
          >
            <IconImage size={14} /><span>Set Image</span>
          </button>
          {imagePath && (
            <button
              onClick={() => {
                setOpenMenu(false);
                invoke("remove_entity_image", { kind: entityType, id: entityId });
                onImageRemoved(entityId);
              }}
            >
              <IconRemoveImage size={14} /><span>Remove Image</span>
            </button>
          )}
          {onRefresh && (
            <button
              onClick={() => {
                setOpenMenu(false);
                onRefresh();
              }}
            >
              <IconRefresh size={14} /><span>Refresh Info</span>
            </button>
          )}
          {activeProviders.length > 0 && entityName && (
            <>
              <div className="artist-image-menu-separator" />
              {activeProviders.map((provider) => {
                const template = provider[urlKey!]!;
                const params = entityType === "artist" ? { artist: entityName } : { title: entityName };
                const url = buildSearchUrl(template, params);
                return (
                  <button
                    key={provider.id}
                    onClick={() => { setOpenMenu(false); openUrl(url); }}
                  >
                    <ProviderIcon provider={provider} /><span>Search on {provider.name}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
