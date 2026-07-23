import { useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { showNativeMenu, type MenuItemSpec } from "../nativeMenu";
import playlistDefault from "../assets/playlist-default.png";

interface SavePlaylistModalProps {
  defaultName: string;
  defaultImage?: string | null;
  onSave: (name: string, imagePath: string | null) => void;
  onClose: () => void;
}

export function SavePlaylistModal({ defaultName, defaultImage, onSave, onClose }: SavePlaylistModalProps) {
  const [name, setName] = useState(defaultName);
  const [imagePath, setImagePath] = useState<string | null>(defaultImage ?? null);
  const [imageError, setImageError] = useState<string | null>(null);

  async function handlePasteImage() {
    try {
      const path = await invoke<string>("paste_clipboard_to_playlist_images");
      setImagePath(path);
      setImageError(null);
    } catch (e) {
      console.error("Failed to paste playlist image:", e);
      setImageError("No image in clipboard");
    }
  }

  async function handleSetImage() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (selected) {
      try {
        const copied = await invoke<string>("copy_to_playlist_images", { sourcePath: selected });
        setImagePath(copied);
        setImageError(null);
      } catch (e) {
        console.error("Failed to set playlist image:", e);
        setImageError("Failed to set image");
      }
    }
  }

  function handleRemoveImage() {
    setImagePath(null);
    setImageError(null);
  }

  function openImageMenu(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const specs: MenuItemSpec[] = [
      { kind: "item", text: "Paste Image", action: handlePasteImage },
      { kind: "item", text: "Set Image", action: handleSetImage },
    ];
    if (imagePath) {
      specs.push({ kind: "item", text: "Remove Image", action: handleRemoveImage });
    }
    showNativeMenu(rect.left, rect.bottom, specs).catch((err) =>
      console.error("Failed to show image options menu:", err)
    );
  }

  function handleSave() {
    if (!name.trim()) return;
    onSave(name.trim(), imagePath);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) handleSave();
  }

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal ds-modal--lg" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Save Playlist</h2>
        <div className="save-playlist-image-row">
          <div className="save-playlist-image-preview">
            <img src={imagePath ? convertFileSrc(imagePath) : playlistDefault} alt="" />
            <div className="artist-image-menu-wrapper">
              <button
                className="artist-image-menu-trigger"
                onClick={openImageMenu}
                title="Image options"
              >
                &#x22EF;
              </button>
            </div>
          </div>
        </div>
        {imageError && <p className="ds-form-error">{imageError}</p>}
        <div className="modal-field">
          <label>Name</label>
          <input
            className="ds-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="ds-btn ds-btn--primary" onClick={handleSave} disabled={!name.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
