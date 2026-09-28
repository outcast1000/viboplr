import { type ReactNode } from "react";
import type { View } from "../types";
import type { PluginSidebarItem, PluginBadge } from "../types/plugin";
import type { UpdateBadge } from "../hooks/useAppUpdater";
import { SpinningDisc } from "./SpinningDisc";
import { track as trackTelemetry } from "../telemetry";
import { FilmReel } from "./FilmReel";
import { pluginIconPath } from "../utils/pluginIconPath";
import "./Sidebar.css";

/** A bare coloured dot means nothing on its own — every state names itself. */
const UPDATE_BADGE_LABEL: Record<UpdateBadge, string> = {
  available: "An update is available",
  error: "The last update attempt failed",
};

const iconProps = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const icons = {
  home: <svg {...iconProps}><path d="M3 12l9-9 9 9M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"/></svg>,
  library: <svg {...iconProps}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>,
  history: <svg {...iconProps}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  playlists: <svg {...iconProps}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>,
  // Fallback Now Playing icon (no current track): a simple static disc outline.
  nowplaying: <svg {...iconProps}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>,
  collections: <svg {...iconProps}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>,
  settings: <svg {...iconProps}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1.08z"/></svg>,
};

const mod = navigator.platform.includes("Mac") ? "\u2318" : "Ctrl+";

function PluginIcon({ name }: { name: string }) {
  const d = pluginIconPath(name);
  return (
    <svg {...iconProps}>
      <path d={d} />
    </svg>
  );
}

interface SidebarProps {
  view: View | `plugin:${string}`;
  /** Only presence is read (`noDetail`) — the shape is the caller's. */
  selectedTrack: unknown | null;
  /** Type of the current track, for the Now Playing icon (disc vs film reel). null = nothing loaded. */
  nowPlayingMedia?: "audio" | "video" | null;
  /** Whether playback is active — the icon spins when true, freezes when false. */
  nowPlayingActive?: boolean;
  collapsed: boolean;
  onShowHome: () => void;
  onShowSearch: () => void;
  onShowHistory: () => void;
  onShowNowPlaying: () => void;
  onShowPlaylists: () => void;
  onShowCollections: () => void;
  onShowSettings: () => void;
  onShowExtensions?: () => void;
  extensionUpdateCount?: number;
  /**
   * Settings dot. One dot, colour-coded by what it wants: an update is ready
   * (accent) or the updater failed (error). `error` wins when both hold — a
   * failure is the more actionable of the two, and the update stays available
   * behind it either way.
   */
  updateBadge?: UpdateBadge | null;
  /**
   * Collections dot: the label from `collectionAlert()` when an enabled
   * collection failed to sync, else null. Doubles as the title/aria-label —
   * colour alone would say "look here" without saying why, and this is the one
   * place a user who doesn't yet know their server is down would have no reason
   * to click.
   */
  collectionAlertLabel?: string | null;
  pluginNavItems?: PluginSidebarItem[];
  onPluginView?: (pluginId: string, viewId: string) => void;
  badgeMap?: Map<string, PluginBadge>;
}

export function Sidebar({
  view,
  selectedTrack,
  nowPlayingMedia,
  nowPlayingActive,
  collapsed,
  onShowHome, onShowSearch, onShowHistory, onShowNowPlaying, onShowPlaylists, onShowCollections, onShowSettings, onShowExtensions,
  extensionUpdateCount,
  updateBadge,
  collectionAlertLabel,
  pluginNavItems,
  onPluginView,
  badgeMap,
}: SidebarProps) {
  const noDetail = selectedTrack === null;
  // Now Playing icon reflects the current track: spinning disc for audio, film
  // reel for video (both rotate while playing, freeze when paused); a static disc
  // when nothing's loaded.
  const nowPlayingIcon: ReactNode =
    nowPlayingMedia === "audio" ? <SpinningDisc size={18} playing={!!nowPlayingActive} />
    : nowPlayingMedia === "video" ? <FilmReel size={18} playing={!!nowPlayingActive} />
    : icons.nowplaying;
  const navItems: { key: string; label: string; icon: ReactNode; active: boolean; onClick: () => void; hint: string }[] = [
    { key: "home", label: "Home", icon: icons.home, active: noDetail && view === "home", onClick: onShowHome, hint: `Home \u2014 ${mod}0` },
    // With colour no longer signalling playback here (see Sidebar.css), rotation is
    // the only visual cue \u2014 and a reduced-motion user has that frozen too. So the
    // hint names the state, per this file's "every state names itself" rule.
    { key: "nowplaying", label: "Now Playing", icon: nowPlayingIcon, active: noDetail && view === "nowplaying", onClick: onShowNowPlaying, hint: `Now Playing \u2014 ${mod}3${nowPlayingMedia ? (nowPlayingActive ? " \u00b7 playing" : " \u00b7 paused") : ""}` },
    { key: "search", label: "Library", icon: icons.library, active: noDetail && view === "search", onClick: onShowSearch, hint: `Library \u2014 ${mod}1` },
    { key: "history", label: "History", icon: icons.history, active: noDetail && view === "history", onClick: onShowHistory, hint: `Play History \u2014 ${mod}2` },
    { key: "playlists", label: "Playlists", icon: icons.playlists, active: noDetail && view === "playlists", onClick: onShowPlaylists, hint: "Playlists" },
  ];

  // Left-pane navigation clicks (anonymous — view key only, e.g. home/search/
  // history/plugin:<id>/settings). Sidebar clicks only, not keyboard shortcuts.
  const navClick = (viewKey: string, fn?: () => void) => {
    trackTelemetry("nav_click", { view: viewKey });
    fn?.();
  };

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <nav className="nav">
        {navItems.map((item) => (
          <button
            key={item.key}
            className={`nav-btn ${item.active ? "active" : ""}`}
            onClick={() => navClick(item.key, item.onClick)}
            title={item.hint}
            /* Collapsed, the button is a bare svg with no text node in it, so
               without this it has no accessible name at all. Set unconditionally
               — expanded it just restates the visible label. */
            aria-label={item.label}
            aria-current={item.active ? "page" : undefined}
          >
            <span className="nav-btn-label">{item.icon} {!collapsed && item.label}</span>
          </button>
        ))}
        {pluginNavItems && pluginNavItems.length > 0 && (
          <>
            <div className="nav-separator" />
            {pluginNavItems.map((item) => {
              const viewKey = `plugin:${item.pluginId}:${item.id}`;
              return (
                <button
                  key={viewKey}
                  className={`nav-btn ${noDetail && view === viewKey ? "active" : ""}`}
                  onClick={() => navClick("plugin:" + item.pluginId, () => onPluginView?.(item.pluginId, item.id))}
                  title={item.label}
                  aria-label={item.label}
                  aria-current={noDetail && view === viewKey ? "page" : undefined}
                >
                  <span className="nav-btn-label">
                    <PluginIcon name={item.icon} /> {!collapsed && item.label}
                  </span>
                  {(() => {
                    const badge = badgeMap?.get(`${item.pluginId}:${item.id}`);
                    if (!badge) return null;
                    if (badge.type === "dot") {
                      return <span className={`plugin-badge-dot plugin-badge--${badge.variant}`} title={badge.tooltip} />;
                    }
                    if (badge.type === "count") {
                      return (
                        <span className={`plugin-badge-count plugin-badge--${badge.variant}`}>
                          {badge.value > 99 ? "99+" : badge.value}
                        </span>
                      );
                    }
                    return null;
                  })()}
                </button>
              );
            })}
          </>
        )}
      </nav>

      <div className="sidebar-bottom">
        <button
          className={`nav-btn sidebar-bottom-btn${noDetail && view === "collections" ? " active" : ""}`}
          onClick={() => navClick("collections", onShowCollections)}
          title={collectionAlertLabel ?? "Collections"}
          aria-label="Collections"
          aria-current={noDetail && view === "collections" ? "page" : undefined}
        >
          <span className="nav-btn-label">{icons.collections} {!collapsed && "Collections"}</span>
          {collectionAlertLabel && (
            <span
              className="update-badge update-badge--error"
              role="status"
              aria-label={collectionAlertLabel}
              title={collectionAlertLabel}
            />
          )}
        </button>
        <button className={`nav-btn sidebar-bottom-btn${noDetail && view === "extensions" ? " active" : ""}`} onClick={() => navClick("extensions", () => onShowExtensions?.())} title="Extensions" aria-label="Extensions" aria-current={noDetail && view === "extensions" ? "page" : undefined}>
          <span className="nav-btn-label">
            <svg {...iconProps}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 17h7M17.5 14v7"/></svg>
            {!collapsed && "Extensions"}
          </span>
          {!!extensionUpdateCount && extensionUpdateCount > 0 && <span className="ext-nav-badge">{extensionUpdateCount}</span>}
        </button>
        <button className={`nav-btn sidebar-bottom-btn${view === "settings" ? " active" : ""}`} onClick={() => navClick("settings", onShowSettings)} title="Settings" aria-label="Settings" aria-current={view === "settings" ? "page" : undefined}>
          <span className="nav-btn-label">{icons.settings} {!collapsed && "Settings"}</span>
          {updateBadge && (
            <span
              className={`update-badge update-badge--${updateBadge}`}
              role="status"
              aria-label={UPDATE_BADGE_LABEL[updateBadge]}
              title={UPDATE_BADGE_LABEL[updateBadge]}
            />
          )}
        </button>
      </div>
    </aside>
  );
}
