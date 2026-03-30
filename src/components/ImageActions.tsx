import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface ImageActionsProps {
  entityId: number;
  entityType: "artist" | "album" | "tag";
  imagePath: string | null | undefined;
  onImageSet: (id: number, path: string) => void;
  onImageRemoved: (id: number) => void;
}

export function ImageActions({ entityId, entityType, imagePath, onImageSet, onImageRemoved }: ImageActionsProps) {
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

  return (
    <div className="artist-image-menu-wrapper" ref={wrapperRef}>
      <button
        className="artist-image-menu-trigger"
        onClick={() => setOpenMenu(v => !v)}
        title="Image options"
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
            Set Image
          </button>
          {imagePath && (
            <button
              onClick={() => {
                setOpenMenu(false);
                invoke("remove_entity_image", { kind: entityType, id: entityId });
                onImageRemoved(entityId);
              }}
            >
              Remove Image
            </button>
          )}
        </div>
      )}
    </div>
  );
}
