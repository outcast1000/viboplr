import { useState } from "react";

export interface TrackMetadataEdit {
  title: string;
  artist: string;
  album: string;
}

interface EditTrackMetadataModalProps {
  defaultTitle: string;
  defaultArtist: string;
  defaultAlbum: string;
  onSave: (fields: TrackMetadataEdit) => void;
  onClose: () => void;
}

// Lightweight editor for a single track's display metadata (title / artist /
// album). Used by the queue panel and the playlist detail view to fix messy
// names — e.g. yt-dlp titles like "Artist - Song (Official Video)" — so the
// entry reads well AND metadata-keyed lookups (lyrics, similar, etc.) resolve.
// It overrides only the edited entry; it never rewrites library rows or file
// tags (that is the Edit Properties / bulk-edit path).
export function EditTrackMetadataModal({ defaultTitle, defaultArtist, defaultAlbum, onSave, onClose }: EditTrackMetadataModalProps) {
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
        <p className="edit-track-note">Changes apply to this entry only.</p>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onClose}>Cancel</button>
          <button className="ds-btn ds-btn--primary" onClick={handleSave} disabled={!title.trim()}>Save</button>
        </div>
      </div>
    </div>
  );
}
