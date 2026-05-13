import { useState, useEffect, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import playlistDefault from "../assets/playlist-default.png";

export interface PlaylistEditInfo {
  source?: string | null;
  description?: string | null;
  metadata?: Record<string, string> | null;
}

interface SavePlaylistModalProps {
  defaultName: string;
  defaultImage?: string | null;
  title?: string;
  info?: PlaylistEditInfo | null;
  onSave: (name: string, imagePath: string | null, info?: PlaylistEditInfo | null) => void;
  onClose: () => void;
}

export function SavePlaylistModal({ defaultName, defaultImage, title, info, onSave, onClose }: SavePlaylistModalProps) {
  const [name, setName] = useState(defaultName);
  const [imagePath, setImagePath] = useState<string | null>(defaultImage ?? null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const [source, setSource] = useState(info?.source ?? "");
  const [description, setDescription] = useState(info?.description ?? "");
  const [metaEntries, setMetaEntries] = useState<Array<{ key: string; value: string }>>(
    info?.metadata ? Object.entries(info.metadata).map(([key, value]) => ({ key, value })) : [],
  );

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

  function handleMetaChange(index: number, field: "key" | "value", val: string) {
    setMetaEntries(prev => prev.map((e, i) => i === index ? { ...e, [field]: val } : e));
  }

  function handleMetaRemove(index: number) {
    setMetaEntries(prev => prev.filter((_, i) => i !== index));
  }

  function handleMetaAdd() {
    setMetaEntries(prev => [...prev, { key: "", value: "" }]);
  }

  function buildInfo(): PlaylistEditInfo | null {
    if (!info) return null;
    const meta: Record<string, string> = {};
    for (const { key, value } of metaEntries) {
      const k = key.trim();
      if (k && value) meta[k] = value;
    }
    return {
      source: source.trim() || null,
      description: description.trim() || null,
      metadata: Object.keys(meta).length > 0 ? meta : null,
    };
  }

  function handleSave() {
    if (!name.trim()) return;
    onSave(name.trim(), imagePath, buildInfo());
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) handleSave();
  }

  const editable = !!info;

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal ds-modal--lg" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">{title || "Save Playlist"}</h2>
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
            className="ds-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>
        {editable && (
          <div className="save-playlist-edit-info">
            <div className="modal-field">
              <label>Source</label>
              <input className="ds-input" type="text" value={source} onChange={e => setSource(e.target.value)} onKeyDown={handleKeyDown} />
            </div>
            <div className="modal-field">
              <label>Description</label>
              <textarea className="ds-input save-playlist-desc-input" value={description} onChange={e => setDescription(e.target.value)} rows={3} />
            </div>
            {metaEntries.length > 0 && (
              <div className="save-playlist-meta-section">
                <label>Metadata</label>
                {metaEntries.map((entry, i) => (
                  <div className="save-playlist-meta-row" key={i}>
                    <input className="ds-input save-playlist-meta-key" type="text" value={entry.key} onChange={e => handleMetaChange(i, "key", e.target.value)} placeholder="key" onKeyDown={handleKeyDown} />
                    <input className="ds-input save-playlist-meta-val" type="text" value={entry.value} onChange={e => handleMetaChange(i, "value", e.target.value)} placeholder="value" onKeyDown={handleKeyDown} />
                    <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={() => handleMetaRemove(i)} title="Remove">&times;</button>
                  </div>
                ))}
              </div>
            )}
            <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={handleMetaAdd} style={{ alignSelf: "flex-start", marginTop: 4 }}>+ Add metadata</button>
          </div>
        )}
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
