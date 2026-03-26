import type { ReactNode } from "react";
import type { View } from "../types";

const iconProps = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const icons = {
  tracks: <svg {...iconProps}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>,
  artists: <svg {...iconProps}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  albums: <svg {...iconProps}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>,
  tags: <svg {...iconProps}><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
  liked: <svg {...iconProps}><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>,
  history: <svg {...iconProps}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  tidal: <svg {...iconProps}><path d="M3 12l4.5-4.5L12 12l-4.5 4.5z"/><path d="M12 7.5L16.5 3 21 7.5 16.5 12z"/><path d="M12 16.5L16.5 12 21 16.5 16.5 21z"/></svg>,
  collections: <svg {...iconProps}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>,
  settings: <svg {...iconProps}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1.08z"/></svg>,
};

const mod = navigator.platform.includes("Mac") ? "\u2318" : "Ctrl+";

interface SidebarProps {
  view: View;
  selectedAlbum: number | null;
  selectedArtist: number | null;
  hasTidal: boolean;
  collapsed: boolean;
  onShowAll: () => void;
  onShowArtists: () => void;
  onShowAlbums: () => void;
  onShowTags: () => void;
  onShowLiked: () => void;
  onShowHistory: () => void;
  onShowTidal: () => void;
  onShowCollections: () => void;
  onShowSettings: () => void;
  updateAvailable: boolean;
}

export function Sidebar({
  view,
  selectedAlbum, selectedArtist,
  hasTidal,
  collapsed,
  onShowAll, onShowArtists, onShowAlbums, onShowTags, onShowLiked, onShowHistory, onShowTidal, onShowCollections, onShowSettings,
  updateAvailable,
}: SidebarProps) {
  const navItems: { key: string; label: string; icon: ReactNode; active: boolean; onClick: () => void; hint: string }[] = [
    { key: "tracks", label: "Tracks", icon: icons.tracks, active: view === "all" && !selectedAlbum, onClick: onShowAll, hint: `Tracks \u2014 ${mod}1` },
    { key: "artists", label: "Artists", icon: icons.artists, active: view === "artists", onClick: onShowArtists, hint: `Artists \u2014 ${mod}2` },
    { key: "albums", label: "Albums", icon: icons.albums, active: view === "albums" && !selectedArtist, onClick: onShowAlbums, hint: `Albums \u2014 ${mod}3` },
    { key: "tags", label: "Tags", icon: icons.tags, active: view === "tags", onClick: onShowTags, hint: `Tags \u2014 ${mod}4` },
    { key: "liked", label: "Liked", icon: icons.liked, active: view === "liked", onClick: onShowLiked, hint: `Liked Tracks \u2014 ${mod}5` },
    { key: "history", label: "History", icon: icons.history, active: view === "history", onClick: onShowHistory, hint: `Play History \u2014 ${mod}6` },
    ...(hasTidal ? [{ key: "tidal", label: "TIDAL", icon: icons.tidal, active: view === "tidal", onClick: onShowTidal, hint: `Search TIDAL \u2014 ${mod}7` }] : []),
    { key: "collections", label: "Collections", icon: icons.collections, active: view === "collections", onClick: onShowCollections, hint: "Collections" },
  ];

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <nav className="nav">
        {navItems.map((item) => (
          <button
            key={item.key}
            className={`nav-btn ${item.active ? "active" : ""}`}
            onClick={item.onClick}
            title={item.hint}
          >
            <span className="nav-btn-label">{item.icon} {!collapsed && item.label}</span>
          </button>
        ))}
      </nav>

      <button className="settings-btn" onClick={onShowSettings} title={collapsed ? "Settings" : undefined}>
        {icons.settings} {!collapsed && "Settings"}
        {updateAvailable && <span className="update-badge" />}
      </button>
    </aside>
  );
}
