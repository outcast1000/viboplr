import { useRef, useEffect, type ReactNode } from "react";
import type { View } from "../types";
import type { PluginSidebarItem, PluginBadge } from "../types/plugin";
import "./Sidebar.css";

const iconProps = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const icons = {
  library: <svg {...iconProps}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>,
  history: <svg {...iconProps}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  playlists: <svg {...iconProps}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>,
  collections: <svg {...iconProps}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>,
  settings: <svg {...iconProps}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1.08z"/></svg>,
};

const mod = navigator.platform.includes("Mac") ? "\u2318" : "Ctrl+";

// Plugin icon SVG paths keyed by name
const pluginIconPaths: Record<string, string> = {
  "chart-bar": "M18 20V10M12 20V4M6 20v-6",
  "globe": "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z",
  "link": "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  "star": "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
  "list": "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  "grid": "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  "search": "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM21 21l-4.35-4.35",
  "bell": "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0",
  "code": "M16 18l6-6-6-6M8 6l-6 6 6 6",
  "puzzle": "M20 8h-2.81a5.45 5.45 0 0 1-.19-1.57A3.44 3.44 0 0 0 13.56 3 3.44 3.44 0 0 0 10 6.43c0 .55.07 1.07.19 1.57H8a2 2 0 0 0-2 2v2.81a5.45 5.45 0 0 1-1.57-.19A3.44 3.44 0 0 0 1 16.06 3.44 3.44 0 0 0 4.43 19.5c.55 0 1.07-.07 1.57-.19V22a2 2 0 0 0 2 2h2.81a5.45 5.45 0 0 1-.19-1.57A3.44 3.44 0 0 1 14.06 19a3.44 3.44 0 0 1 3.44 3.43c0 .55-.07 1.07-.19 1.57H20a2 2 0 0 0 2-2v-2.81a5.45 5.45 0 0 1-1.57.19A3.44 3.44 0 0 1 17 15.94a3.44 3.44 0 0 1 3.43-3.44c.55 0 1.07.07 1.57.19V10a2 2 0 0 0-2-2z",
  "music": "M9 18V5l12-2v13M6 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  "spotify": "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM8.5 16c2.5-1 5.5-1 7.5 0M7 13c3-1.5 7.5-1.5 10.5 0M5.5 10c4-2 9.5-2 13.5 0",
  "heart": "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z",
  "clock": "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2",
  "folder": "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
};

function PluginIcon({ name }: { name: string }) {
  const d = pluginIconPaths[name] || pluginIconPaths["puzzle"];
  return (
    <svg {...iconProps}>
      <path d={d} />
    </svg>
  );
}

interface SidebarProps {
  view: View | `plugin:${string}`;
  selectedTrack: number | null;
  collapsed: boolean;
  onShowSearch: () => void;
  onShowHistory: () => void;
  onShowPlaylists: () => void;
  onShowCollections: () => void;
  onShowSettings: () => void;
  onShowExtensions?: () => void;
  extensionUpdateCount?: number;
  updateAvailable: boolean;
  pluginNavItems?: PluginSidebarItem[];
  onPluginView?: (pluginId: string, viewId: string) => void;
  badgeMap?: Map<string, PluginBadge>;
}

export function Sidebar({
  view,
  selectedTrack,
  collapsed,
  onShowSearch, onShowHistory, onShowPlaylists, onShowCollections, onShowSettings, onShowExtensions,
  extensionUpdateCount,
  updateAvailable,
  pluginNavItems,
  onPluginView,
  badgeMap,
}: SidebarProps) {
  const navRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!navRef.current || !indicatorRef.current) return;
    const activeBtn = navRef.current.querySelector(".nav-btn.active") as HTMLElement | null;
    if (activeBtn) {
      indicatorRef.current.style.transform = `translateY(${activeBtn.offsetTop}px)`;
      indicatorRef.current.style.height = `${activeBtn.offsetHeight}px`;
      indicatorRef.current.style.opacity = "1";
    } else {
      indicatorRef.current.style.opacity = "0";
    }
  }, [view, selectedTrack]);

  const noDetail = selectedTrack === null;
  const navItems: { key: string; label: string; icon: ReactNode; active: boolean; onClick: () => void; hint: string }[] = [
    { key: "search", label: "Library", icon: icons.library, active: noDetail && view === "search", onClick: onShowSearch, hint: `Library \u2014 ${mod}1` },
    { key: "history", label: "History", icon: icons.history, active: noDetail && view === "history", onClick: onShowHistory, hint: `Play History \u2014 ${mod}2` },
    { key: "playlists", label: "Playlists", icon: icons.playlists, active: noDetail && view === "playlists", onClick: onShowPlaylists, hint: "Playlists" },
  ];

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <nav className="nav" ref={navRef}>
        <div className="sidebar-indicator" ref={indicatorRef} />
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
        {pluginNavItems && pluginNavItems.length > 0 && (
          <>
            <div className="nav-separator" />
            {pluginNavItems.map((item) => {
              const viewKey = `plugin:${item.pluginId}:${item.id}`;
              return (
                <button
                  key={viewKey}
                  className={`nav-btn ${noDetail && view === viewKey ? "active" : ""}`}
                  onClick={() => onPluginView?.(item.pluginId, item.id)}
                  title={item.label}
                >
                  <span className="nav-btn-label">
                    <PluginIcon name={item.icon} /> {!collapsed && item.label}
                  </span>
                  {(() => {
                    const badge = badgeMap?.get(`${item.pluginId}:${item.id}`);
                    if (!badge) return null;
                    if (badge.type === "dot") {
                      return <span className={`plugin-badge-dot plugin-badge--${badge.variant}`} />;
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
        <button className={`nav-btn sidebar-bottom-btn${noDetail && view === "collections" ? " active" : ""}`} onClick={onShowCollections} title={collapsed ? "Collections" : undefined}>
          <span className="nav-btn-label">{icons.collections} {!collapsed && "Collections"}</span>
        </button>
        <button className={`nav-btn sidebar-bottom-btn${noDetail && view === "extensions" ? " active" : ""}`} onClick={() => onShowExtensions?.()} title={collapsed ? "Extensions" : undefined}>
          <span className="nav-btn-label">
            <svg {...iconProps}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 17h7M17.5 14v7"/></svg>
            {!collapsed && "Extensions"}
          </span>
          {!!extensionUpdateCount && extensionUpdateCount > 0 && <span className="ext-nav-badge">{extensionUpdateCount}</span>}
        </button>
        <button className={`nav-btn sidebar-bottom-btn${view === "settings" ? " active" : ""}`} onClick={onShowSettings} title={collapsed ? "Settings" : undefined}>
          <span className="nav-btn-label">{icons.settings} {!collapsed && "Settings"}</span>
          {updateAvailable && <span className="update-badge" />}
        </button>
      </div>
    </aside>
  );
}
