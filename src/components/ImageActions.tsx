import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface ImageActionsProps {
  entityId: number;
  entityType: "artist" | "album";
  imagePath: string | null | undefined;
  onImageSet: (id: number, path: string) => void;
  onImageRemoved: (id: number) => void;
}

export function ImageActions({ entityId, entityType, imagePath, onImageSet, onImageRemoved }: ImageActionsProps) {
  const setCommand = entityType === "artist" ? "set_artist_image" : "set_album_image";
  const removeCommand = entityType === "artist" ? "remove_artist_image" : "remove_album_image";
  const idKey = entityType === "artist" ? "artistId" : "albumId";

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
            const newPath = await invoke<string>(setCommand, {
              [idKey]: entityId,
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
            invoke(removeCommand, { [idKey]: entityId });
            onImageRemoved(entityId);
          }}
        >
          Remove Image
        </button>
      )}
    </div>
  );
}
