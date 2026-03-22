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
  return (
    <div className="artist-image-actions">
      <button
        className="artist-image-btn"
        onClick={async () => {
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
          className="artist-image-btn"
          onClick={() => {
            invoke("remove_entity_image", { kind: entityType, id: entityId });
            onImageRemoved(entityId);
          }}
        >
          Remove Image
        </button>
      )}
    </div>
  );
}
