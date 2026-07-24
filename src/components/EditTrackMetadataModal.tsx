import { useState } from "react";
import { formatDuration } from "../utils";

export interface TrackMetadataEdit {
  title: string;
  artist: string;
  album: string;
}

export interface TrackInfoEntry {
  label: string;
  value: string;
}

// Read-only facts about the entry being edited — everything the surface knows
// about the track except internal identifiers (queue key, DB row ids). Fields
// without a value are skipped.
export function buildTrackInfoEntries(fields: {
  position?: number | null;
  durationSecs?: number | null;
  format?: string | null;
  source?: string | null;
  imageUrl?: string | null;
  liked?: number | null;
}): TrackInfoEntry[] {
  const entries: TrackInfoEntry[] = [];
  if (fields.position != null) entries.push({ label: "Position", value: String(fields.position) });
  if (fields.durationSecs != null) entries.push({ label: "Duration", value: formatDuration(fields.durationSecs) });
  if (fields.format) entries.push({ label: "Format", value: fields.format });
  if (fields.source) entries.push({ label: "Source", value: fields.source });
  if (fields.imageUrl) entries.push({ label: "Image", value: fields.imageUrl });
  if (fields.liked === 1) entries.push({ label: "Rating", value: "Liked" });
  else if (fields.liked === -1) entries.push({ label: "Rating", value: "Disliked" });
  return entries;
}

interface EditTrackMetadataModalProps {
  defaultTitle: string;
  defaultArtist: string;
  defaultAlbum: string;
  info?: TrackInfoEntry[];
  onSave: (fields: TrackMetadataEdit) => void;
  onClose: () => void;
}

// Lightweight editor for a single track's display metadata (title / artist /
// album). Used by the queue panel and the playlist detail view to fix messy
// names — e.g. yt-dlp titles like "Artist - Song (Official Video)" — so the
// entry reads well AND metadata-keyed lookups (lyrics, similar, etc.) resolve.
// It overrides only the edited entry; it never rewrites library rows or file
// tags (that is the Edit Properties / bulk-edit path).
export function EditTrackMetadataModal({ defaultTitle, defaultArtist, defaultAlbum, info, onSave, onClose }: EditTrackMetadataModalProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [artist, setArtist] = useState(defaultArtist);
  const [album, setAlbum] = useState(defaultAlbum);

  function handleSave() {
    if (!title.trim()) return;
    onSave({ title: title.trim(), artist: artist.trim(), album: album.trim() });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) handleSave();
  }

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Edit Track Info</h2>
        <div className="modal-field">
          <label>Title</label>
          <input className="ds-input" type="text" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={handleKeyDown} autoFocus />
        </div>
        <div className="modal-field">
          <label>Artist</label>
          <input className="ds-input" type="text" value={artist} onChange={(e) => setArtist(e.target.value)} onKeyDown={handleKeyDown} />
        </div>
        <div className="modal-field">
          <label>Album</label>
          <input className="ds-input" type="text" value={album} onChange={(e) => setAlbum(e.target.value)} onKeyDown={handleKeyDown} />
        </div>
        {info?.map((entry) => (
          <div className="modal-field" key={entry.label}>
            <label>{entry.label}</label>
            <div className="modal-field-static modal-field-path" title={entry.value}>{entry.value}</div>
          </div>
        ))}
        <p className="edit-track-note">Changes apply to this entry only.</p>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onClose}>Cancel</button>
          <button className="ds-btn ds-btn--primary" onClick={handleSave} disabled={!title.trim()}>Save</button>
        </div>
      </div>
    </div>
  );
}
