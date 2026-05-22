import { useState, useCallback, useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track, QueueTrack } from "../types";
import type { PluginViewData, CardGridItem, StatItem, TrackRowItem, PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";
import { showNativeMenu, type MenuItemSpec } from "../nativeMenu";
import { formatDuration } from "../utils";
import { ViewSearchBar } from "./ViewSearchBar";
import "./PluginViewRenderer.css";

function resolveImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return convertFileSrc(url);
}

interface PluginViewRendererProps {
  pluginName: string;
  data: PluginViewData | undefined;
  currentTrack: QueueTrack | null;
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
    while (i < data.children.length && (data.children[i].type === "search-input" || data.children[i].type === "tabs" || data.children[i].type === "toolbar")) {
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
  currentTrack: QueueTrack | null;
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
          categories={node.categories}
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
          className={node.className || (node.variant === "accent" ? "ds-btn ds-btn--primary" : "plugin-button")}
          onClick={() => onAction?.(node.action, node.data)}
          disabled={node.disabled}
          style={node.style as React.CSSProperties | undefined}
        >
          {node.label}
        </button>
      );
    case "layout":
      return (
        <div
          className={`plugin-layout plugin-layout-${node.direction}${node.className ? " " + node.className : ""}`}
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
          submitOnly={node.submitOnly}
          onAction={onAction}
        />
      );
    case "text-input":
      return (
        <PluginTextInput
          placeholder={node.placeholder}
          action={node.action}
          value={node.value}
          multiline={node.multiline}
          rows={node.rows}
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
    case "toolbar":
      return (
        <div className="plugin-toolbar">
          {node.title && <span className="plugin-toolbar-title">{node.title}</span>}
          <div className="plugin-toolbar-buttons">
            {node.buttons?.map((btn, i) => (
              <button
                key={i}
                className={btn.variant === "accent" ? "ds-btn ds-btn--primary ds-btn--sm" : "plugin-toolbar-btn"}
                onClick={() => onAction?.(btn.action, btn.data)}
                disabled={btn.disabled}
              >
                {btn.icon && <span className="plugin-toolbar-btn-icon" dangerouslySetInnerHTML={{ __html: btn.icon }} />}
                {btn.label}
              </button>
            ))}
          </div>
          {node.status && (
            <span className={`plugin-toolbar-status${node.statusVariant === "error" ? " plugin-toolbar-status--error" : node.statusVariant === "success" ? " plugin-toolbar-status--success" : ""}`}>
              {node.status}
            </span>
          )}
        </div>
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
    case "settings-row": {
      const control = node.control || node.child;
      return (
        <PluginSettingsRow label={node.label} description={node.description}>
          {control && (
            <PluginViewNode
              node={control}
              currentTrack={currentTrack}
              onPlayTrack={onPlayTrack}
              onAction={onAction}
              onTrackContextMenu={onTrackContextMenu}
              onTrackRowContextMenu={onTrackRowContextMenu}
            />
          )}
        </PluginSettingsRow>
      );
    }
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
    case "confirm":
      return (
        <PluginConfirm
          title={node.title}
          message={node.message}
          confirmLabel={node.confirmLabel}
          cancelLabel={node.cancelLabel}
          confirmVariant={node.confirmVariant}
          confirmAction={node.confirmAction}
          cancelAction={node.cancelAction}
          data={node.data}
          onAction={onAction}
        />
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
          playAction={node.playAction}
          contextMenuActions={node.contextMenuActions}
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
  playAction,
  contextMenuActions,
  onAction,
}: {
  title: string;
  subtitle?: string;
  meta?: string;
  imageUrl?: string;
  actions?: { id: string; label: string; icon?: string }[];
  backAction?: string;
  playAction?: string;
  contextMenuActions?: { id: string; label: string; separator?: boolean }[];
  onAction?: (actionId: string, data?: unknown) => void;
}) {
  const showMenu = useCallback(async (x: number, y: number) => {
    if (!contextMenuActions?.length) return;
    const specs: MenuItemSpec[] = contextMenuActions.map(action =>
      action.separator
        ? { kind: "separator" as const }
        : { kind: "item" as const, text: action.label, action: () => onAction?.(action.id) }
    );
    await showNativeMenu(x, y, specs);
  }, [contextMenuActions, onAction]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!contextMenuActions?.length) return;
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY);
  }, [contextMenuActions, showMenu]);

  const handleMoreClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showMenu(rect.right, rect.bottom + 4);
  }, [showMenu]);

  return (
    <>
      {backAction && (
        <button className="plugin-detail-back" onClick={() => onAction?.(backAction)}>
          {"\u2190"} Back
        </button>
      )}
      <div
        className="album-detail-top"
        style={imageUrl ? { '--artist-bg': `url(${resolveImageUrl(imageUrl)})` } as React.CSSProperties : undefined}
      >
        <div className="album-detail-header">
          <div className="album-detail-art" onContextMenu={handleContextMenu}>
            {imageUrl ? (
              <img className="album-detail-art-img" src={resolveImageUrl(imageUrl)} alt={title} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
            ) : (
              <svg className="album-detail-art-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
            {contextMenuActions?.length ? (
              <button
                className="ds-card-menu"
                title="More options"
                onClick={handleMoreClick}
              >
                &#x22EF;
              </button>
            ) : null}
            {playAction && (
              <button
                className="ds-card-play"
                title="Play"
                onClick={(e) => { e.stopPropagation(); onAction?.(playAction); }}
              >
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
              </button>
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
  currentTrack: QueueTrack | null;
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
            const isCurrent = currentTrack?.path != null && currentTrack.path === track.path;
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
  const showCardMenu = useCallback(async (x: number, y: number, item: CardGridItem) => {
    if (!item.contextMenuActions?.length) return;
    const specs: MenuItemSpec[] = item.contextMenuActions.map(action =>
      action.separator
        ? { kind: "separator" as const }
        : { kind: "item" as const, text: action.label, action: () => onAction?.(action.id, { itemId: item.id }) }
    );
    const targetKind = item.targetKind ?? "playlist";
    const matching = pluginMenuItems?.filter(mi => mi.targets.includes(targetKind)) ?? [];
    if (matching.length > 0) {
      specs.push({ kind: "separator" });
      matching.forEach(mi => {
        specs.push({ kind: "item", text: mi.label, action: () => onPluginAction?.(mi.pluginId, mi.id, { kind: targetKind, playlistName: item.title, tracks: item.tracks }) });
      });
    }
    await showNativeMenu(x, y, specs);
  }, [onAction, pluginMenuItems, onPluginAction]);

  const handleContextMenu = useCallback((e: React.MouseEvent, item: CardGridItem) => {
    if (!item.contextMenuActions?.length) return;
    e.preventDefault();
    e.stopPropagation();
    showCardMenu(e.clientX, e.clientY, item);
  }, [showCardMenu]);

  const handleMoreClick = useCallback((e: React.MouseEvent, item: CardGridItem) => {
    e.stopPropagation();
    if (!item.contextMenuActions?.length) return;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    showCardMenu(rect.left, rect.bottom + 4, item);
  }, [showCardMenu]);

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
              <img src={resolveImageUrl(item.imageUrl)} alt={item.title} />
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
  "pre",
  "br",
  "a",
  "ul",
  "ol",
  "li",
  "div",
  "span",
  "code",
  "img",
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
  submitOnly,
  onAction,
}: {
  placeholder?: string;
  action: string;
  value?: string;
  submitOnly?: boolean;
  onAction?: (actionId: string, data?: unknown) => void;
}) {
  const [query, setQuery] = useState(value ?? "");
  const handleChange = useCallback((q: string) => {
    setQuery(q);
    if (!submitOnly) {
      onAction?.(action, { query: q });
    }
  }, [action, onAction, submitOnly]);
  const handleSubmit = useCallback(() => {
    onAction?.(action, { query });
  }, [action, query, onAction]);
  return (
    <ViewSearchBar
      query={query}
      onQueryChange={handleChange}
      onEnter={handleSubmit}
      placeholder={placeholder ?? "Search..."}
    />
  );
}

function PluginTextInput({
  placeholder,
  action,
  value,
  multiline,
  rows,
  onAction,
}: {
  placeholder?: string;
  action: string;
  value?: string;
  multiline?: boolean;
  rows?: number;
  onAction?: (actionId: string, data?: unknown) => void;
}) {
  const [text, setText] = useState(value ?? "");
  const prevValue = useRef(value);
  if (value !== prevValue.current) {
    prevValue.current = value;
    setText(value ?? "");
  }
  if (multiline) {
    return (
      <textarea
        className="ds-input"
        placeholder={placeholder ?? ""}
        value={text}
        rows={rows || 4}
        onChange={(e) => {
          setText(e.target.value);
          onAction?.(action, { value: e.target.value });
        }}
        style={{ flex: 1, resize: "vertical" }}
      />
    );
  }
  return (
    <input
      className="ds-input"
      type="text"
      placeholder={placeholder ?? ""}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onAction?.(action, { value: e.target.value });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && text.trim()) {
          onAction?.(action + ":submit", { value: text.trim() });
        }
      }}
      style={{ flex: 1 }}
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
  categories,
  onAction,
  onContextMenu,
}: {
  items: TrackRowItem[];
  selectable?: boolean;
  actions?: { id: string; label: string; icon?: string }[];
  categories?: string[];
  onAction?: (actionId: string, data?: unknown) => void;
  onContextMenu?: (e: React.MouseEvent, item: TrackRowItem) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [itemCategories, setItemCategories] = useState<Record<string, string[]>>(() => {
    if (!categories) return {};
    const init: Record<string, string[]> = {};
    for (const item of items) {
      init[item.id] = item.checked || [];
    }
    return init;
  });

  useEffect(() => {
    if (!categories) return;
    setItemCategories(prev => {
      const next: Record<string, string[]> = {};
      for (const item of items) {
        next[item.id] = prev[item.id] || item.checked || [];
      }
      return next;
    });
  }, [items, categories]);

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

  const toggleCategory = useCallback((itemId: string, cat: string) => {
    setItemCategories(prev => {
      const current = prev[itemId] || [];
      const next = current.includes(cat) ? current.filter(c => c !== cat) : [...current, cat];
      return { ...prev, [itemId]: next };
    });
  }, []);

  const hasSelection = selectable ? selected.size > 0 : false;
  const hasAnyCategories = categories ? Object.values(itemCategories).some(cats => cats.length > 0) : false;

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
      {!selectable && categories && actions && actions.length > 0 && (
        <div className="ptr-toolbar">
          <div className="ptr-toolbar-left">
            <span className="ptr-toolbar-count">{items.length} candidates</span>
          </div>
          <div className="ptr-toolbar-right">
            {actions.map(a => (
              <button
                key={a.id}
                className="ptr-toolbar-btn"
                disabled={!hasAnyCategories}
                onClick={() => onAction?.(a.id, { items: itemCategories })}
              >
                {a.icon && <span className="ptr-toolbar-icon">{a.icon}</span>}
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {categories && (
        <div className="ptr-category-header">
          {categories.map(cat => (
            <span key={cat} className="ptr-category-label">{cat}</span>
          ))}
          <span className="ptr-category-spacer" />
        </div>
      )}
      <PluginTrackRowsBody
        items={items}
        selected={selected}
        toggleSelect={toggleSelect}
        selectable={selectable}
        categories={categories}
        itemCategories={itemCategories}
        toggleCategory={toggleCategory}
        onAction={onAction}
        onContextMenu={onContextMenu}
      />
    </div>
  );
}

function PluginTrackRowsBody({
  items,
  selected,
  toggleSelect,
  selectable,
  categories,
  itemCategories,
  toggleCategory,
  onAction,
  onContextMenu,
}: {
  items: TrackRowItem[];
  selected: Set<string>;
  toggleSelect: (id: string) => void;
  selectable?: boolean;
  categories?: string[];
  itemCategories: Record<string, string[]>;
  toggleCategory: (itemId: string, cat: string) => void;
  onAction?: (actionId: string, data?: unknown) => void;
  onContextMenu?: (e: React.MouseEvent, item: TrackRowItem) => void;
}) {
  // For long lists we apply `content-visibility: auto` per row via a CSS class.
  // The browser skips layout/paint for off-screen rows — same end result as
  // hand-rolled virtualization, no nested scroll containers, no flicker.
  const useCv = items.length > 100;
  return (
    <div className={`ptr-rows${useCv ? " ptr-rows-cv" : ""}`}>
      {items.map(item => (
        <div
          key={item.id}
          className={`ptr-row${selected.has(item.id) ? " ptr-row-selected" : ""}`}
          onClick={() => item.action && onAction?.(item.action, { itemId: item.id })}
          onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, item); } : undefined}
        >
          {categories && (
            <div className="ptr-categories">
              {categories.map(cat => (
                <input
                  key={cat}
                  type="checkbox"
                  className="ptr-cat-checkbox"
                  checked={(itemCategories[item.id] || []).includes(cat)}
                  onChange={(e) => { e.stopPropagation(); toggleCategory(item.id, cat); }}
                  onClick={(e) => e.stopPropagation()}
                />
              ))}
            </div>
          )}
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
              <img src={resolveImageUrl(item.imageUrl)} alt="" loading="lazy" decoding="async" />
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

// -- Confirm dialog --

function PluginConfirm({
  title,
  message,
  confirmLabel,
  cancelLabel,
  confirmVariant,
  confirmAction,
  cancelAction,
  data,
  onAction,
}: {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "accent" | "secondary" | "danger";
  confirmAction: string;
  cancelAction: string;
  data?: unknown;
  onAction?: (actionId: string, data?: unknown) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onAction?.(cancelAction, data);
      else if (e.key === "Enter") onAction?.(confirmAction, data);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmAction, cancelAction, data, onAction]);

  const confirmClass =
    confirmVariant === "danger" ? "ds-btn ds-btn--danger"
    : confirmVariant === "secondary" ? "ds-btn ds-btn--secondary"
    : "ds-btn ds-btn--primary";

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        {title && <div className="ds-modal-title">{title}</div>}
        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{message}</div>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--secondary" onClick={() => onAction?.(cancelAction, data)}>
            {cancelLabel || "Cancel"}
          </button>
          <button className={confirmClass} onClick={() => onAction?.(confirmAction, data)} autoFocus>
            {confirmLabel || "Confirm"}
          </button>
        </div>
      </div>
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
