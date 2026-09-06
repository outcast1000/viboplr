import { useEffect, useMemo, useState } from "react";
import type { UserPlaylist } from "../hooks/useUserPlaylists";

interface PlaylistPickerModalProps {
  /** Recency-ordered user playlists (useUserPlaylists). */
  playlists: UserPlaylist[];
  /** Hide this playlist (a playlist detail view excludes itself). */
  excludeId?: number;
  /** How many tracks are being added — drives the title. */
  trackCount: number;
  onPick: (playlistId: number, playlistName: string) => void;
  onClose: () => void;
}

/**
 * Searchable playlist picker behind the "Add to Playlist ▸ All N playlists…"
 * menu entry — a native submenu can't carry a search field, so past the cap
 * the long tail lives here. Type to filter, ArrowUp/Down + Enter or click to
 * pick, Escape to close. Never closes on overlay click (modal convention).
 */
export function PlaylistPickerModal({ playlists, excludeId, trackCount, onPick, onClose }: PlaylistPickerModalProps) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  const candidates = useMemo(() => {
    const pool = excludeId != null ? playlists.filter(p => p.id !== excludeId) : playlists;
    const q = query.trim().toLowerCase();
    return q ? pool.filter(p => p.name.toLowerCase().includes(q)) : pool;
  }, [playlists, excludeId, query]);

  // The rendered cursor clamps to the live candidate list, so a narrowing
  // filter can't leave it pointing past the end (derived, not an effect).
  const cursor = Math.max(0, Math.min(highlight, candidates.length - 1));

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function handleInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight(Math.min(cursor + 1, candidates.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(Math.max(cursor - 1, 0));
    } else if (e.key === "Enter") {
      const pick = candidates[cursor];
      if (pick) onPick(pick.id, pick.name);
    }
  }

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">
          Add {trackCount} track{trackCount === 1 ? "" : "s"} to…
        </h2>
        <input
          className="ds-input"
          type="text"
          placeholder="Search playlists..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleInputKeyDown}
          autoFocus
        />
        <div className="ds-list playlist-picker-list">
          {candidates.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className={`ds-list-item${i === cursor ? " highlighted" : ""}`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => onPick(p.id, p.name)}
            >
              <span className="ds-list-item-name">{p.name}</span>
            </button>
          ))}
          {candidates.length === 0 && <div className="empty">No matching playlists.</div>}
        </div>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
