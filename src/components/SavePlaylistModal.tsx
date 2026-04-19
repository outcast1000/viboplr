import { useState, useEffect, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import playlistDefault from "../assets/playlist-default.png";

interface SavePlaylistModalProps {
  defaultName: string;
  onSave: (name: string, imagePath: string | null) => void;
  onClose: () => void;
}

export function SavePlaylistModal({ defaultName, onSave, onClose }: SavePlaylistModalProps) {
  const [name, setName] = useState(defaultName);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [menuOpen]);

  async function handlePasteImage() {
    setMenuOpen(false);
    try {
      const path = await invoke<string>("paste_clipboard_to_playlist_images");
      setImagePath(path);
    } catch { /* clipboard empty or no image */ }
  }

  async function handleSetImage() {
    setMenuOpen(false);
    const selected = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (selected) {
      try {
        const copied = await invoke<string>("copy_to_playlist_images", { sourcePath: selected });
        setImagePath(copied);
      } catch { /* ignore */ }
    }
  }

  function handleRemoveImage() {
    setMenuOpen(false);
    setImagePath(null);
  }

  function handleSave() {
    if (!name.trim()) return;
    onSave(name.trim(), imagePath);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSave();
  }

  return (
    <div className="ds-modal-overlay" onClick={onClose}>
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Save Playlist</h2>
        <div className="save-playlist-image-row">
          <div className="save-playlist-image-preview">
            <img src={imagePath ? convertFileSrc(imagePath) : playlistDefault} alt="" />
            <div className="artist-image-menu-wrapper" ref={menuRef}>
              <button
                className="artist-image-menu-trigger"
                onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
                title="Image options"
              >
                &#x22EF;
              </button>
              {menuOpen && (
                <div className="artist-image-menu-dropdown">
                  <button onClick={handlePasteImage}>
                    <span>Paste Image</span>
                  </button>
                  <button onClick={handleSetImage}>
                    <span>Set Image</span>
                  </button>
                  {imagePath && (
                    <button onClick={handleRemoveImage}>
                      <span>Remove Image</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="modal-field">
          <label>Name</label>
          <input
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
