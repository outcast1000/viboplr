import type { View } from "../types";

interface SidebarProps {
  view: View;
  selectedAlbum: number | null;
  selectedArtist: number | null;
  onShowAll: () => void;
  onShowArtists: () => void;
  onShowAlbums: () => void;
  onShowTags: () => void;
  onShowLiked: () => void;
  onShowHistory: () => void;
  onShowSettings: () => void;
}

export function Sidebar({
  view,
  selectedAlbum, selectedArtist,
  onShowAll, onShowArtists, onShowAlbums, onShowTags, onShowLiked, onShowHistory, onShowSettings,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <nav className="nav">
        <button
          className={`nav-btn ${view === "all" && !selectedAlbum ? "active" : ""}`}
          onClick={onShowAll}
        >
          Tracks
        </button>
        <button
          className={`nav-btn ${view === "artists" ? "active" : ""}`}
          onClick={onShowArtists}
        >
          Artists
        </button>
        <button
          className={`nav-btn ${view === "albums" && !selectedArtist ? "active" : ""}`}
          onClick={onShowAlbums}
        >
          Albums
        </button>
        <button
          className={`nav-btn ${view === "tags" ? "active" : ""}`}
          onClick={onShowTags}
        >
          Tags
        </button>
        <button
          className={`nav-btn ${view === "liked" ? "active" : ""}`}
          onClick={onShowLiked}
        >
          Liked
        </button>
        <button
          className={`nav-btn ${view === "history" ? "active" : ""}`}
          onClick={onShowHistory}
        >
          History
        </button>
      </nav>

      <button className="settings-btn" onClick={onShowSettings}>
        Settings
      </button>
    </aside>
  );
}
