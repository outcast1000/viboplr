import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SearchProviderConfig } from "../searchProviders";
import { buildSearchUrl, getDomainFromUrl } from "../searchProviders";
import { IconImage, IconRemoveImage, IconGoogle, IconLastfm, IconX, IconYoutube, IconGenius } from "./Icons";
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

interface AlbumOptionsMenuProps {
  albumId: number;
  albumImagePath: string | null;
  albumTitle: string;
  artistName: string;
  providers: SearchProviderConfig[];
  onImageSet: (id: number, path: string) => void;
  onImageRemoved: (id: number) => void;
}

export function AlbumOptionsMenu({ albumId, albumImagePath, albumTitle, artistName, providers, onImageSet, onImageRemoved }: AlbumOptionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isOpen]);

  return (
    <div className="artist-image-menu-wrapper" ref={wrapperRef}>
      <button
        className="artist-image-menu-trigger"
        onClick={(e) => { e.stopPropagation(); setIsOpen(v => !v); }}
        title="Options"
      >
        &#x22EF;
      </button>
      {isOpen && (
        <div className="artist-image-menu-dropdown">
          <button
            onClick={async () => {
              setIsOpen(false);
              const selected = await open({
                multiple: false,
                filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
              });
              if (selected) {
                const newPath = await invoke<string>("set_entity_image", {
                  kind: "album",
                  id: albumId,
                  sourcePath: selected,
                });
                onImageSet(albumId, newPath);
              }
            }}
          >
            <IconImage size={14} /><span>Set Image</span>
          </button>
          {albumImagePath && (
            <button
              onClick={() => {
                setIsOpen(false);
                invoke("remove_entity_image", { kind: "album", id: albumId });
                onImageRemoved(albumId);
              }}
            >
              <IconRemoveImage size={14} /><span>Remove Image</span>
            </button>
          )}
          {providers.length > 0 && (
            <>
              <div className="artist-image-menu-separator" />
              {providers.map((provider) => {
                const url = buildSearchUrl(provider.albumUrl!, { title: albumTitle, artist: artistName });
                return (
                  <button
                    key={provider.id}
                    onClick={() => { setIsOpen(false); openUrl(url); }}
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
