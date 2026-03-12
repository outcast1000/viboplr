import type { View } from "../types";

interface SidebarProps {
  view: View;
  trackCount: number;
  artistCount: number;
  albumCount: number;
  tagCount: number;
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
  view, trackCount, artistCount, albumCount, tagCount,
  selectedAlbum, selectedArtist,
  onShowAll, onShowArtists, onShowAlbums, onShowTags, onShowLiked, onShowHistory, onShowSettings,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <h1 className="logo">FastPlayer</h1>
      <nav className="nav">
        <button
          className={`nav-btn ${view === "all" && !selectedAlbum ? "active" : ""}`}
          onClick={onShowAll}
        >
          All Tracks <span className="nav-count">{trackCount}</span>
        </button>
        <button
          className={`nav-btn ${view === "artists" ? "active" : ""}`}
          onClick={onShowArtists}
        >
          Artists <span className="nav-count">{artistCount}</span>
        </button>
        <button
          className={`nav-btn ${view === "albums" && !selectedArtist ? "active" : ""}`}
          onClick={onShowAlbums}
        >
          Albums <span className="nav-count">{albumCount}</span>
        </button>
        <button
          className={`nav-btn ${view === "tags" ? "active" : ""}`}
          onClick={onShowTags}
        >
          Tags <span className="nav-count">{tagCount}</span>
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
