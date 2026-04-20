import { useState, useCallback, useEffect, useRef } from "react";
import type { Track } from "../types";
import type { PluginViewData, CardGridItem, StatItem, TrackRowItem, PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";
import { ViewSearchBar } from "./ViewSearchBar";
import "./PluginViewRenderer.css";

interface PluginViewRendererProps {
  pluginName: string;
  data: PluginViewData | undefined;
  currentTrack: Track | null;
  onPlayTrack?: (track: Track) => void;
  onAction?: (actionId: string, data?: unknown) => void;
  onTrackContextMenu?: (e: React.MouseEvent, track: Track) => void;
  onTrackRowContextMenu?: (e: React.MouseEvent, item: TrackRowItem) => void;
  pluginMenuItems?: PluginMenuItem[];
  onPluginAction?: (pluginId: string, actionId: string, target: PluginContextMenuTarget) => void;
}

export function PluginViewRenderer({
  data,
  currentTrack,
  onPlayTrack,
  onAction,
  onTrackContextMenu,
  onTrackRowContextMenu,
  pluginMenuItems,
  onPluginAction,
}: PluginViewRendererProps) {
  if (!data) {
    return (
      <div className="plugin-view">
        <div className="plugin-view-empty">No content</div>
      </div>
    );
  }

  // Hoist top-level search-input and tabs out of the scrollable area
  const hoisted: PluginViewData[] = [];
  let contentData = data;
  if (data.type === "layout" && data.direction === "vertical") {
    let i = 0;
    while (i < data.children.length && (data.children[i].type === "search-input" || data.children[i].type === "tabs")) {
      hoisted.push(data.children[i]);
      i++;
    }
    if (hoisted.length > 0) {
      contentData = { ...data, children: data.children.slice(i) };
    }
  }

  return (
    <>
      {hoisted.map((node, i) => (
        <PluginViewNode
          key={i}
          node={node}
          currentTrack={currentTrack}
          onPlayTrack={onPlayTrack}
          onAction={onAction}
          onTrackContextMenu={onTrackContextMenu}
          onTrackRowContextMenu={onTrackRowContextMenu}
          pluginMenuItems={pluginMenuItems}
          onPluginAction={onPluginAction}
        />
      ))}
      <div className="plugin-view">
        <div className="plugin-view-content">
          <PluginViewNode
            node={contentData}
            currentTrack={currentTrack}
            onPlayTrack={onPlayTrack}
            onAction={onAction}
            onTrackContextMenu={onTrackContextMenu}
            onTrackRowContextMenu={onTrackRowContextMenu}
            pluginMenuItems={pluginMenuItems}
            onPluginAction={onPluginAction}
          />
        </div>
      </div>
    </>
  );
}

interface PluginViewNodeProps {
  node: PluginViewData;
  currentTrack: Track | null;
  onPlayTrack?: (track: Track) => void;
  onAction?: (actionId: string, data?: unknown) => void;
  onTrackContextMenu?: (e: React.MouseEvent, track: Track) => void;
  onTrackRowContextMenu?: (e: React.MouseEvent, item: TrackRowItem) => void;
  pluginMenuItems?: PluginMenuItem[];
  onPluginAction?: (pluginId: string, actionId: string, target: PluginContextMenuTarget) => void;
}

function PluginViewNode({
  node,
  currentTrack,
  onPlayTrack,
  onAction,
  onTrackContextMenu,
  onTrackRowContextMenu,
  pluginMenuItems,
  onPluginAction,
}: PluginViewNodeProps) {
  switch (node.type) {
    case "track-list":
      return (
        <PluginTrackList
          tracks={node.tracks}
          title={node.title}
          currentTrack={currentTrack}
          onDoubleClick={onPlayTrack}
          onContextMenu={onTrackContextMenu}
        />
      );
    case "card-grid":
      return (
        <PluginCardGrid
          items={node.items}
          columns={node.columns}
          onAction={onAction}
          pluginMenuItems={pluginMenuItems}
          onPluginAction={onPluginAction}
        />
      );
    case "track-row-list":
      return (
        <PluginTrackRowList
          items={node.items}
          selectable={node.selectable}
          actions={node.actions}
          onAction={onAction}
          onContextMenu={onTrackRowContextMenu}
        />
      );
    case "text":
      return <PluginText content={node.content} className={node.className} />;
    case "stats-grid":
      return <PluginStatsGrid items={node.items} />;
    case "button":
      return (
        <button
          className={node.variant === "accent" ? "ds-btn ds-btn--primary" : "plugin-button"}
          onClick={() => onAction?.(node.action)}
          disabled={node.disabled}
          style={node.style as React.CSSProperties | undefined}
        >
          {node.label}
        </button>
      );
    case "layout":
      return (
        <div
          className={`plugin-layout plugin-layout-${node.direction}`}
        >
          {node.children.map((child, i) => (
            <PluginViewNode
              key={i}
              node={child}
              currentTrack={currentTrack}
              onPlayTrack={onPlayTrack}
              onAction={onAction}
              onTrackContextMenu={onTrackContextMenu}
              onTrackRowContextMenu={onTrackRowContextMenu}
              pluginMenuItems={pluginMenuItems}
              onPluginAction={onPluginAction}
            />
          ))}
        </div>
      );
    case "spacer":
      return <div className="plugin-spacer" />;
    case "search-input":
      return (
        <PluginSearchInput
          placeholder={node.placeholder}
          action={node.action}
          value={node.value}
          onAction={onAction}
        />
      );
    case "tabs":
      return (
        <PluginTabs
          tabs={node.tabs}
          activeTab={node.activeTab}
          action={node.action}
          onAction={onAction}
        />
      );
    case "loading":
      return <PluginLoading message={node.message} />;
    case "toggle":
      return (
        <PluginToggle
          label={node.label}
          description={node.description}
          checked={node.checked}
          action={node.action}
          onAction={onAction}
          disabled={node.disabled}
        />
      );
    case "select":
      return (
        <PluginSelect
          label={node.label}
          description={node.description}
          value={node.value}
          options={node.options}
          action={node.action}
          onAction={onAction}
        />
      );
    case "progress-bar":
      return <PluginProgressBar value={node.value} max={node.max} label={node.label} />;
    case "settings-row":
      return (
        <PluginSettingsRow label={node.label} description={node.description}>
          <PluginViewNode
            node={node.control}
            currentTrack={currentTrack}
            onPlayTrack={onPlayTrack}
            onAction={onAction}
            onTrackContextMenu={onTrackContextMenu}
            onTrackRowContextMenu={onTrackRowContextMenu}
          />
        </PluginSettingsRow>
      );
    case "section":
      return (
        <div className="settings-group">
          <div className="settings-group-title">{node.title}</div>
          <div className="settings-card">
            {node.children.map((child, i) => (
              <PluginViewNode
                key={i}
                node={child}
                currentTrack={currentTrack}
                onPlayTrack={onPlayTrack}
                onAction={onAction}
                onTrackContextMenu={onTrackContextMenu}
                onTrackRowContextMenu={onTrackRowContextMenu}
              />
            ))}
          </div>
        </div>
      );
    case "detail-header":
      return (
        <PluginDetailHeader
          title={node.title}
          subtitle={node.subtitle}
          meta={node.meta}
          imageUrl={node.imageUrl}
          actions={node.actions}
          backAction={node.backAction}
          onAction={onAction}
        />
      );
    default:
      return null;
  }
}

// -- Detail Header (album/artist style) --

function PluginDetailHeader({
  title,
  subtitle,
  meta,
  imageUrl,
  actions,
  backAction,
  onAction,
}: {
  title: string;
  subtitle?: string;
  meta?: string;
  imageUrl?: string;
  actions?: { id: string; label: string; icon?: string }[];
  backAction?: string;
  onAction?: (actionId: string, data?: unknown) => void;
}) {
  return (
    <>
      {backAction && (
        <button className="plugin-detail-back" onClick={() => onAction?.(backAction)}>
          {"\u2190"} Back
        </button>
      )}
      <div
        className="album-detail-top"
        style={imageUrl ? { '--artist-bg': `url(${imageUrl})` } as React.CSSProperties : undefined}
      >
        <div className="album-detail-header">
          <div className="album-detail-art">
            {imageUrl ? (
              <img className="album-detail-art-img" src={imageUrl} alt={title} />
            ) : (
              <svg className="album-detail-art-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </div>
          <div className="album-detail-info">
            <h2>
              {title}
              {actions?.map((a) => (
                <button
                  key={a.id}
                  className="artist-play-btn"
                  title={a.label}
                  onClick={() => onAction?.(a.id)}
                >
                  {a.icon || a.label}
                </button>
              ))}
            </h2>
            {subtitle && <span className="album-detail-artist-name">{subtitle}</span>}
            {meta && <span className="artist-meta">{meta}</span>}
          </div>
        </div>
      </div>
    </>
  );
}

// -- Track List (simplified read-only) --

function PluginTrackList({
  tracks,
  title,
  currentTrack,
  onDoubleClick,
  onContextMenu,
}: {
  tracks: Track[];
  title?: string;
  currentTrack: Track | null;
  onDoubleClick?: (track: Track) => void;
  onContextMenu?: (e: React.MouseEvent, track: Track) => void;
}) {
  if (tracks.length === 0) {
    return <div className="plugin-track-list-empty">No tracks</div>;
  }
  return (
    <div className="plugin-track-list">
      {title && <h3 className="plugin-section-title">{title}</h3>}
      <table className="plugin-track-table">
        <thead>
          <tr>
            <th className="col-num">#</th>
            <th className="col-title">Title</th>
            <th className="col-artist">Artist</th>
            <th className="col-album">Album</th>
            <th className="col-duration">Duration</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((track, i) => {
            const isCurrent = currentTrack?.id === track.id;
            return (
              <tr
                key={track.id}
                className={isCurrent ? "track-row active" : "track-row"}
                onDoubleClick={() => onDoubleClick?.(track)}
                onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, track); } : undefined}
              >
                <td className="col-num">{i + 1}</td>
                <td className="col-title">{track.title}</td>
                <td className="col-artist">{track.artist_name ?? ""}</td>
                <td className="col-album">{track.album_title ?? ""}</td>
                <td className="col-duration">
                  {track.duration_secs != null
                    ? formatDuration(track.duration_secs)
                    : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// -- Card Grid --

function PluginCardGrid({
  items,
  columns,
  onAction,
  pluginMenuItems,
  onPluginAction,
}: {
  items: CardGridItem[];
  columns?: number;
  onAction?: (actionId: string, data?: unknown) => void;
  pluginMenuItems?: PluginMenuItem[];
  onPluginAction?: (pluginId: string, actionId: string, target: PluginContextMenuTarget) => void;
}) {
  const [contextMenu, setContextMenu] = useState<{ item: CardGridItem; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [contextMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, item: CardGridItem) => {
    if (!item.contextMenuActions?.length) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ item, x: e.clientX, y: e.clientY });
  }, []);

  const handleMoreClick = useCallback((e: React.MouseEvent, item: CardGridItem) => {
    e.stopPropagation();
    if (!item.contextMenuActions?.length) return;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setContextMenu({ item, x: rect.left, y: rect.bottom + 4 });
  }, []);

  const contextTargetKind = contextMenu?.item.targetKind ?? "playlist";
  const matchingPluginItems = pluginMenuItems?.filter(item => item.targets.includes(contextTargetKind)) ?? [];

  return (
    <div
      className="plugin-card-grid"
      style={
        columns
          ? {
              gridTemplateColumns: `repeat(${columns}, 1fr)`,
            }
          : undefined
      }
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="plugin-card"
          onClick={
            item.action
              ? () => onAction?.(item.action!, { itemId: item.id })
              : undefined
          }
          onContextMenu={item.contextMenuActions?.length ? (e) => handleContextMenu(e, item) : undefined}
        >
          <div className="plugin-card-art">
            {item.imageUrl ? (
              <img src={item.imageUrl} alt={item.title} />
            ) : (
              <div style={{ width: "100%", height: "100%", background: "var(--bg-surface)" }} />
            )}
            {item.contextMenuActions?.some(a => a.id === "play-playlist") && (
              <button
                className="plugin-card-play"
                onClick={(e) => {
                  e.stopPropagation();
                  onAction?.("play-playlist", { itemId: item.id });
                }}
                title="Play"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              </button>
            )}
          </div>
          <div className="plugin-card-info">
            <div className="plugin-card-title">{item.title}</div>
            {item.contextMenuActions?.length ? (
              <button
                className="plugin-card-more"
                onClick={(e) => handleMoreClick(e, item)}
                title="More options"
              >
                &#x22EF;
              </button>
            ) : null}
          </div>
          {item.subtitle && (
            <div className="plugin-card-subtitle">{item.subtitle}</div>
          )}
        </div>
      ))}
      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.item.contextMenuActions!.map((action) =>
            action.separator ? (
              <div key={action.id} className="context-menu-separator" />
            ) : (
              <div
                key={action.id}
                className="context-menu-item"
                onClick={() => {
                  onAction?.(action.id, { itemId: contextMenu.item.id });
                  setContextMenu(null);
                }}
              >
                <span>{action.label}</span>
              </div>
            )
          )}
          {matchingPluginItems.length > 0 && (
            <>
              <div className="context-menu-separator" />
              {matchingPluginItems.map((mi) => (
                <div
                  key={`${mi.pluginId}:${mi.id}`}
                  className="context-menu-item"
                  onClick={() => {
                    onPluginAction?.(mi.pluginId, mi.id, {
                      kind: contextTargetKind,
                      playlistName: contextMenu.item.title,
                      tracks: contextMenu.item.tracks,
                    });
                    setContextMenu(null);
                  }}
                >
                  <span>{mi.label}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// -- Text (sanitized HTML subset) --

const ALLOWED_TAGS = new Set([
  "b",
  "i",
  "em",
  "strong",
  "h2",
  "h3",
  "p",
  "br",
  "a",
  "ul",
  "ol",
  "li",
]);

export function sanitizeHTML(html: string): string {
  // Strip tags not in allowlist
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tag) => {
    return ALLOWED_TAGS.has(tag.toLowerCase()) ? match : "";
  });
}

function PluginText({ content, className }: { content: string; className?: string }) {
  const cls = className ? `plugin-text ${className}` : "plugin-text";
  if (/<[a-zA-Z]/.test(content)) {
    return (
      <div
        className={cls}
        dangerouslySetInnerHTML={{ __html: sanitizeHTML(content) }}
      />
    );
  }
  return <div className={cls}>{content}</div>;
}

// -- Stats Grid --

function PluginStatsGrid({ items }: { items: StatItem[] }) {
  return (
    <div className="plugin-stats-grid">
      {items.map((item, i) => (
        <div key={i} className="plugin-stat">
          <div className="plugin-stat-value">{item.value}</div>
          <div className="plugin-stat-label">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

// -- Search Input --

function PluginSearchInput({
  placeholder,
  action,
  value,
  onAction,
}: {
  placeholder?: string;
  action: string;
  value?: string;
  onAction?: (actionId: string, data?: unknown) => void;
}) {
  const [query, setQuery] = useState(value ?? "");
  return (
    <ViewSearchBar
      query={query}
      onQueryChange={setQuery}
      placeholder={placeholder ?? "Search..."}
      onEnter={() => {
        if (query.trim()) onAction?.(action, { query: query.trim() });
      }}
    />
  );
}

// -- Tabs --

function PluginTabs({
  tabs,
  activeTab,
  action,
  onAction,
}: {
  tabs: { id: string; label: string; count?: number }[];
  activeTab: string;
  action: string;
  onAction?: (actionId: string, data?: unknown) => void;
}) {
  return (
    <div className="ds-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`ds-tab${tab.id === activeTab ? " active" : ""}`}
          onClick={() => onAction?.(action, { tabId: tab.id })}
        >
          {tab.label}
          {tab.count != null && tab.count > 0 && (
            <span className="ds-tab-badge">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// -- Track Row List --

function PluginTrackRowList({
  items,
  selectable,
  actions,
  onAction,
  onContextMenu,
}: {
  items: TrackRowItem[];
  selectable?: boolean;
  actions?: { id: string; label: string; icon?: string }[];
  onAction?: (actionId: string, data?: unknown) => void;
  onContextMenu?: (e: React.MouseEvent, item: TrackRowItem) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(items.map(i => i.id)));
  }, [items]);

  const selectNone = useCallback(() => {
    setSelected(new Set());
  }, []);

  const hasSelection = selected.size > 0;

  return (
    <div className="ptr-list">
      {selectable && (
        <div className="ptr-toolbar">
          <div className="ptr-toolbar-left">
            <button className="ptr-toolbar-btn" onClick={selectAll}>All</button>
            <button className="ptr-toolbar-btn" onClick={selectNone}>None</button>
            <span className="ptr-toolbar-count">{selected.size} / {items.length}</span>
          </div>
          {actions && actions.length > 0 && (
            <div className="ptr-toolbar-right">
              {actions.map(a => (
                <button
                  key={a.id}
                  className="ptr-toolbar-btn"
                  disabled={!hasSelection}
                  onClick={() => onAction?.(a.id, { selectedIds: Array.from(selected) })}
                >
                  {a.icon && <span className="ptr-toolbar-icon">{a.icon}</span>}
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="ptr-rows">
        {items.map(item => (
          <div
            key={item.id}
            className={`ptr-row${selected.has(item.id) ? " ptr-row-selected" : ""}`}
            onClick={() => item.action && onAction?.(item.action, { itemId: item.id })}
            onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, item); } : undefined}
          >
            {selectable && (
              <input
                type="checkbox"
                className="ptr-checkbox"
                checked={selected.has(item.id)}
                onChange={(e) => { e.stopPropagation(); toggleSelect(item.id); }}
                onClick={(e) => e.stopPropagation()}
              />
            )}
            {item.imageUrl && (
              <div className="ptr-art">
                <img src={item.imageUrl} alt="" />
              </div>
            )}
            <div className="ptr-info">
              <span className="ptr-title">{item.title}</span>
              {item.subtitle && <span className="ptr-subtitle">{item.subtitle}</span>}
            </div>
            {item.duration && <span className="ptr-duration">{item.duration}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// -- Loading --

function PluginLoading({ message }: { message?: string }) {
  return (
    <div className="plugin-loading">
      <div className="plugin-loading-spinner" />
      {message && <div>{message}</div>}
    </div>
  );
}

// -- Toggle --

function PluginToggle({
  label,
  description,
  checked,
  action,
  onAction,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  action: string;
  onAction?: (actionId: string, data?: unknown) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`plugin-settings-row${disabled ? " plugin-settings-row-disabled" : ""}`}>
      <div className="plugin-settings-row-info">
        <span className="plugin-settings-label">{label}</span>
        {description && <span className="plugin-settings-description">{description}</span>}
      </div>
      <button
        className={`ds-toggle${checked ? " on" : ""}`}
        onClick={() => onAction?.(action, { value: !checked })}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
      >
        <span className="ds-toggle-thumb" />
      </button>
    </div>
  );
}

// -- Select --

function PluginSelect({
  label,
  description,
  value,
  options,
  action,
  onAction,
}: {
  label: string;
  description?: string;
  value: string;
  options: { value: string; label: string }[];
  action: string;
  onAction?: (actionId: string, data?: unknown) => void;
}) {
  return (
    <div className="plugin-settings-row">
      <div className="plugin-settings-row-info">
        <span className="plugin-settings-label">{label}</span>
        {description && <span className="plugin-settings-description">{description}</span>}
      </div>
      <select
        className="plugin-select"
        value={value}
        onChange={(e) => onAction?.(action, { value: e.target.value })}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

// -- Progress Bar --

function PluginProgressBar({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label?: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="plugin-progress">
      <div className="plugin-progress-bar">
        <div className="plugin-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      {label && <div className="plugin-progress-label">{label}</div>}
    </div>
  );
}

// -- Settings Row --

function PluginSettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="plugin-settings-row">
      <div className="plugin-settings-row-info">
        <span className="plugin-settings-label">{label}</span>
        {description && <span className="plugin-settings-description">{description}</span>}
      </div>
      {children}
    </div>
  );
}
