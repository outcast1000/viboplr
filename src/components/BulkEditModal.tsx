import { useState, useMemo, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Track } from "../types";
import { emitTrackPatch } from "../trackEvents";
import AutocompleteInput from "./AutocompleteInput";
import { effectiveTagNames } from "../utils/bulkEditTags";

interface BulkEditModalProps {
  tracks: Track[];
  artistOptions: string[];
  albumOptions: string[];
  tagOptions: string[];
  onClose: () => void;
  onSave: () => void;
}

interface TagEntry {
  name: string;
}

function FieldRow({ label, dirty, onRevert, children }: {
  label: string;
  dirty: boolean;
  onRevert: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-field">
      <label className="bulk-edit-field-label">
        <span>{label}{dirty && <span className="bulk-edit-dirty-dot" aria-label="modified" />}</span>
        {dirty && (
          <button type="button" className="bulk-edit-revert" onClick={onRevert} title="Revert this field">↺</button>
        )}
      </label>
      {children}
    </div>
  );
}

export default function BulkEditModal({ tracks, artistOptions, albumOptions, tagOptions, onClose, onSave }: BulkEditModalProps) {
  const count = tracks.length;

  // For a single track, show its file name (basename) under the title.
  const singleFileName = useMemo(() => {
    if (count !== 1) return null;
    const path = tracks[0].path;
    if (!path) return null;
    const bare = path.startsWith("file://") ? path.slice("file://".length) : path;
    const decoded = (() => { try { return decodeURIComponent(bare); } catch { return bare; } })();
    const segments = decoded.split(/[/\\]/);
    return segments[segments.length - 1] || decoded;
  }, [count, tracks]);

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

  const [title, setTitle] = useState(count === 1 ? tracks[0].title : "");
  const [dirtyTitle, setDirtyTitle] = useState(false);
  const [trackNumber, setTrackNumber] = useState(
    count === 1 && tracks[0].track_number != null ? String(tracks[0].track_number) : "",
  );
  const [dirtyTrackNumber, setDirtyTrackNumber] = useState(false);
  const [artist, setArtist] = useState(shared.artist);
  const [album, setAlbum] = useState(shared.album);
  const [year, setYear] = useState(shared.year);
  const [tags, setTags] = useState<TagEntry[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagsLoaded, setTagsLoaded] = useState(false);
  const [tagMode, setTagMode] = useState<"replace" | "add" | "remove">("replace");

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

  // In add/remove modes the pills are a delta, not the full set — start empty.
  useEffect(() => {
    if (tagMode !== "replace") {
      setTags([]);
      setTagInput("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagMode]);

  const hasDirtyFields = dirtyArtist || dirtyAlbum || dirtyYear || dirtyTags || dirtyTitle || dirtyTrackNumber || tagInput.trim().length > 0;

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
    if (e.key === ",") {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === "Backspace" && tagInput === "" && tags.length > 0) {
      removeTag(tags[tags.length - 1].name);
    }
  }

  async function handleSave() {
    setSaving(true);
    setErrors([]);

    // Flush any pending tag text into the effective list (tested helper).
    const effectiveTagList = effectiveTagNames(tags, tagInput);
    const tagsChanged =
      tagMode === "replace"
        ? dirtyTags || effectiveTagList.length !== tags.length
        : effectiveTagList.length > 0;

    const fields: Record<string, unknown> = {};
    if (dirtyArtist) fields.artist_name = artist || null;
    if (dirtyAlbum) fields.album_title = album || null;
    if (dirtyYear) fields.year = year ? parseInt(year, 10) : null;
    if (dirtyTitle) fields.title = title;
    if (dirtyTrackNumber) fields.track_number = trackNumber ? parseInt(trackNumber, 10) : null;
    if (tagsChanged) {
      fields.tag_names = effectiveTagList;
      fields.tag_mode = tagMode;
    }

    try {
      const result = await invoke<string[]>("bulk_update_tracks", {
        trackIds: tracks.map((t) => t.id),
        fields,
      });
      if (result.length > 0) {
        setErrors(result);
      } else {
        const patch: Partial<Track> = {};
        if (dirtyArtist) patch.artist_name = artist || null;
        if (dirtyAlbum) patch.album_title = album || null;
        if (dirtyYear) patch.year = year ? parseInt(year, 10) : null;
        if (dirtyTitle) patch.title = title;
        if (dirtyTrackNumber) patch.track_number = trackNumber ? parseInt(trackNumber, 10) : null;
        if (Object.keys(patch).length > 0) {
          for (const t of tracks) {
            if (t.id != null) emitTrackPatch(t.id, patch);
          }
        }
        onSave();
      }
    } catch (e) {
      setErrors([String(e)]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ds-modal-overlay">
      <div
        className="ds-modal"
        style={{ width: 420 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.defaultPrevented) return; // let AutocompleteInput consume its own keys
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && hasDirtyFields && !saving) {
            e.preventDefault();
            handleSave();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h3 className="ds-modal-title">Edit {count} Track{count !== 1 ? "s" : ""}</h3>
        {singleFileName && (
          <p className="bulk-edit-filename" title={singleFileName}>{singleFileName}</p>
        )}

        {count === 1 && (
          <>
            <FieldRow label="Title" dirty={dirtyTitle} onRevert={() => { setTitle(tracks[0].title); setDirtyTitle(false); }}>
              <input
                className="ds-input"
                type="text"
                value={title}
                onChange={(e) => { setTitle(e.target.value); setDirtyTitle(true); }}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </FieldRow>
            <FieldRow label="Track #" dirty={dirtyTrackNumber} onRevert={() => { setTrackNumber(tracks[0].track_number != null ? String(tracks[0].track_number) : ""); setDirtyTrackNumber(false); }}>
              <input
                className="ds-input"
                type="number"
                value={trackNumber}
                onChange={(e) => { setTrackNumber(e.target.value); setDirtyTrackNumber(true); }}
                style={{ width: 120 }}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </FieldRow>
          </>
        )}

        <FieldRow label="Artist" dirty={dirtyArtist} onRevert={() => { setArtist(shared.artist); setDirtyArtist(false); }}>
          <AutocompleteInput
            value={artist}
            onChange={(v) => { setArtist(v); setDirtyArtist(true); }}
            suggestions={artistOptions}
            placeholder={shared.artistPlaceholder}
          />
        </FieldRow>

        <FieldRow label="Album" dirty={dirtyAlbum} onRevert={() => { setAlbum(shared.album); setDirtyAlbum(false); }}>
          <AutocompleteInput
            value={album}
            onChange={(v) => { setAlbum(v); setDirtyAlbum(true); }}
            suggestions={albumOptions}
            placeholder={shared.albumPlaceholder}
          />
        </FieldRow>

        <FieldRow label="Year" dirty={dirtyYear} onRevert={() => { setYear(shared.year); setDirtyYear(false); }}>
          <input
            className="ds-input"
            type="number"
            value={year}
            placeholder={shared.yearPlaceholder}
            onChange={(e) => { setYear(e.target.value); setDirtyYear(true); }}
            style={{ width: 120 }}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </FieldRow>

        <div className="modal-field">
          <label className="bulk-edit-field-label">
            <span>Tags{count === 1 ? "" : tagMode === "add" ? " · add to existing" : tagMode === "remove" ? " · remove from tracks" : " · replace"}</span>
          </label>
          {count > 1 && (
            <div className="bulk-edit-tagmode" role="group" aria-label="Tag edit mode">
              {(["replace", "add", "remove"] as const).map((m) => (
                <button
                  type="button"
                  key={m}
                  className={`bulk-edit-tagmode-btn${tagMode === m ? " active" : ""}`}
                  onClick={() => setTagMode(m)}
                >
                  {m === "replace" ? "Replace" : m === "add" ? "Add" : "Remove"}
                </button>
              ))}
            </div>
          )}
          <div className="bulk-edit-tags-input">
            {tags.map((t) => (
              <span key={t.name} className="bulk-edit-tag-pill">
                {t.name}
                <span className="bulk-edit-tag-remove" onClick={() => removeTag(t.name)}>&times;</span>
              </span>
            ))}
            <AutocompleteInput
              value={tagInput}
              onChange={setTagInput}
              suggestions={tagOptions}
              exclude={new Set(tags.map((t) => t.name.toLowerCase()))}
              onCommit={addTag}
              onKeyDownExtra={handleTagKeyDown}
              placeholder={!tagsLoaded ? "Loading tags..." : tags.length === 0 ? "Type and press Enter..." : ""}
              disabled={!tagsLoaded}
              inputClassName="bulk-edit-tag-text-input"
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
