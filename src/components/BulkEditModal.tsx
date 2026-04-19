import { useState, useMemo, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Track } from "../types";

interface BulkEditModalProps {
  tracks: Track[];
  onClose: () => void;
}

interface TagEntry {
  name: string;
}

export default function BulkEditModal({ tracks, onClose }: BulkEditModalProps) {
  const count = tracks.length;

  // Compute shared values
  const shared = useMemo(() => {
    const artists = new Set(tracks.map((t) => t.artist_name ?? ""));
    const albums = new Set(tracks.map((t) => t.album_title ?? ""));
    const years = new Set(tracks.map((t) => t.year));
    return {
      artist: artists.size === 1 ? [...artists][0] : "",
      artistPlaceholder: artists.size === 1 ? undefined : "Multiple values",
      album: albums.size === 1 ? [...albums][0] : "",
      albumPlaceholder: albums.size === 1 ? undefined : "Multiple values",
      year: years.size === 1 && [...years][0] != null ? String([...years][0]) : "",
      yearPlaceholder: years.size === 1 ? undefined : "Multiple values",
    };
  }, [tracks]);

  const [artist, setArtist] = useState(shared.artist);
  const [album, setAlbum] = useState(shared.album);
  const [year, setYear] = useState(shared.year);
  const [tags, setTags] = useState<TagEntry[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagsLoaded, setTagsLoaded] = useState(false);

  const [dirtyArtist, setDirtyArtist] = useState(false);
  const [dirtyAlbum, setDirtyAlbum] = useState(false);
  const [dirtyYear, setDirtyYear] = useState(false);
  const [dirtyTags, setDirtyTags] = useState(false);

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Fetch existing tags for selected tracks
  useEffect(() => {
    async function fetchTags() {
      try {
        // Fetch tags for each track and find common ones
        const allTagSets: Set<string>[] = [];
        for (const track of tracks) {
          const trackTags = await invoke<{ id: number; name: string }[]>("get_tags_for_track", { trackId: track.id });
          allTagSets.push(new Set(trackTags.map(t => t.name)));
        }
        // Find tags common to ALL tracks
        if (allTagSets.length > 0) {
          const commonTags = [...allTagSets[0]].filter(tag =>
            allTagSets.every(s => s.has(tag))
          );
          if (commonTags.length > 0) {
            setTags(commonTags.map(name => ({ name })));
          }
        }
      } catch (e) {
        console.error("Failed to fetch tags:", e);
      }
      setTagsLoaded(true);
    }
    fetchTags();
  }, [tracks]);

  const hasDirtyFields = dirtyArtist || dirtyAlbum || dirtyYear || dirtyTags;

  function addTag(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (tags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) return;
    setTags((prev) => [...prev, { name: trimmed }]);
    setDirtyTags(true);
    setTagInput("");
  }

  function removeTag(name: string) {
    setTags((prev) => prev.filter((t) => t.name !== name));
    setDirtyTags(true);
  }

  function handleTagKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === "Backspace" && tagInput === "" && tags.length > 0) {
      removeTag(tags[tags.length - 1].name);
    }
  }

  async function handleSave() {
    setSaving(true);
    setErrors([]);

    const fields: Record<string, unknown> = {};
    if (dirtyArtist) fields.artist_name = artist || null;
    if (dirtyAlbum) fields.album_title = album || null;
    if (dirtyYear) fields.year = year ? parseInt(year, 10) : null;
    if (dirtyTags) fields.tag_names = tags.map((t) => t.name);

    try {
      const result = await invoke<string[]>("bulk_update_tracks", {
        trackIds: tracks.map((t) => t.id),
        fields,
      });
      if (result.length > 0) {
        setErrors(result);
      } else {
        onClose();
      }
    } catch (e) {
      setErrors([String(e)]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ds-modal-overlay" onClick={onClose}>
      <div className="ds-modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <h3 className="ds-modal-title">Edit {count} Track{count !== 1 ? "s" : ""}</h3>

        <div className="modal-field">
          <label>Artist</label>
          <input
            className="ds-input"
            type="text"
            value={artist}
            placeholder={shared.artistPlaceholder}
            onChange={(e) => { setArtist(e.target.value); setDirtyArtist(true); }}
          />
        </div>

        <div className="modal-field">
          <label>Album</label>
          <input
            className="ds-input"
            type="text"
            value={album}
            placeholder={shared.albumPlaceholder}
            onChange={(e) => { setAlbum(e.target.value); setDirtyAlbum(true); }}
          />
        </div>

        <div className="modal-field">
          <label>Year</label>
          <input
            className="ds-input"
            type="number"
            value={year}
            placeholder={shared.yearPlaceholder}
            onChange={(e) => { setYear(e.target.value); setDirtyYear(true); }}
            style={{ width: 120 }}
          />
        </div>

        <div className="modal-field">
          <label>Tags{dirtyTags ? " (replace mode)" : ""}</label>
          <div className="bulk-edit-tags-input">
            {tags.map((t) => (
              <span key={t.name} className="bulk-edit-tag-pill">
                {t.name}
                <span className="bulk-edit-tag-remove" onClick={() => removeTag(t.name)}>&times;</span>
              </span>
            ))}
            <input
              type="text"
              value={tagInput}
              placeholder={!tagsLoaded ? "Loading tags..." : tags.length === 0 ? "Type and press Enter..." : ""}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              onBlur={() => { if (tagInput.trim()) addTag(tagInput); }}
              className="bulk-edit-tag-text-input"
              disabled={!tagsLoaded}
            />
          </div>
        </div>

        {errors.length > 0 && (
          <div className="bulk-edit-errors">
            <p style={{ margin: "0 0 4px", fontWeight: 600 }}>Some files could not be updated:</p>
            {errors.map((e, i) => (
              <p key={i} style={{ margin: 0, fontSize: "var(--fs-xs)" }}>{e}</p>
            ))}
          </div>
        )}

        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onClose}>Cancel</button>
          <button
            className="ds-btn ds-btn--primary"
            onClick={handleSave}
            disabled={!hasDirtyFields || saving}
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
