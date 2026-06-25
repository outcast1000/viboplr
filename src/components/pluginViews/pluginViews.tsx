// Leaf renderers for PluginViewData node types (split out of PluginViewRenderer.tsx).
// The recursive dispatcher PluginViewNode lives in PluginViewRenderer.tsx and
// imports these; none of these renderers recurse back into the dispatcher.
import { useState, useCallback, useEffect, useRef, useId } from "react";
import type { Track, QueueTrack } from "../../types";
import type { CardGridItem, StatItem, TrackRowItem, PluginMenuItem, PluginContextMenuTarget } from "../../types/plugin";
import { showNativeMenu, type MenuItemSpec } from "../../nativeMenu";
import { formatDuration } from "../../utils";
import { ViewSearchBar } from "../ViewSearchBar";
import { resolveImageUrl } from "../../utils/resolveImageUrl";
import { sanitizeHTML } from "./htmlSanitize";

// -- Track List (simplified read-only) --

export function PluginTrackList({
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

export function PluginCardGrid({
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
                className="ds-card-play"
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


export function PluginText({ content, className }: { content: string; className?: string }) {
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

export function PluginStatsGrid({ items }: { items: StatItem[] }) {
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

export function PluginSearchInput({
  placeholder,
  action,
  value,
  submitOnly,
  buttonLabel,
  onAction,
}: {
  placeholder?: string;
  action: string;
  value?: string;
  submitOnly?: boolean;
  buttonLabel?: string;
  onAction?: (actionId: string, data?: unknown) => void;
}) {
  const [query, setQuery] = useState(value ?? "");
  // A search button makes the input submit-only: changes never fire the action,
  // only Enter or an explicit button click do.
  const submitOnlyEffective = submitOnly || !!buttonLabel;
  const handleChange = useCallback((q: string) => {
    setQuery(q);
    if (!submitOnlyEffective) {
      onAction?.(action, { query: q });
    }
  }, [action, onAction, submitOnlyEffective]);
  const handleSubmit = useCallback(() => {
    onAction?.(action, { query });
  }, [action, query, onAction]);
  return (
    <ViewSearchBar
      query={query}
      onQueryChange={handleChange}
      onEnter={handleSubmit}
      placeholder={placeholder ?? "Search..."}
    >
      {buttonLabel && (
        <button
          className="ds-btn ds-btn--primary view-search-submit-btn"
          onClick={handleSubmit}
          disabled={!query.trim()}
        >
          {buttonLabel}
        </button>
      )}
    </ViewSearchBar>
  );
}

export function PluginTextInput({
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

export function PluginTabs({
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

interface PluginTrackRowListProps {
  items: TrackRowItem[];
  selectable?: boolean;
  actions?: { id: string; label: string; icon?: string }[];
  categories?: string[];
  numbered?: boolean;
  showHeader?: boolean;
  onAction?: (actionId: string, data?: unknown) => void;
  onContextMenu?: (e: React.MouseEvent, item: TrackRowItem) => void;
}

/**
 * Library-style click selection for plugin rows, keyed by item id + index.
 * Mirrors `TrackList.computeSelection`: a plain click replaces the selection,
 * Cmd/Ctrl+click toggles one item, Shift+click selects a range from the last
 * clicked index, and Cmd/Ctrl+Shift+click extends the existing selection with
 * that range. Exported for unit testing.
 */
export function computeRowSelection(
  current: Set<string>,
  items: { id: string }[],
  clickedIndex: number,
  lastIndex: number | null,
  meta: boolean,
  shift: boolean,
): Set<string> {
  if (shift) {
    const start = lastIndex ?? 0;
    const lo = Math.min(start, clickedIndex);
    const hi = Math.max(start, clickedIndex);
    const range = new Set(items.slice(lo, hi + 1).map(it => it.id));
    if (meta) {
      const merged = new Set(current);
      for (const id of range) merged.add(id);
      return merged;
    }
    return range;
  }
  if (meta) {
    const next = new Set(current);
    const id = items[clickedIndex].id;
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }
  return new Set([items[clickedIndex].id]);
}

// Dispatcher: the `selectable` row list (used by e.g. the YouTube search view)
// renders the library-style listbox below; everything else (the `categories`
// interactive-download flow, plain/`showHeader`/`numbered` lists) keeps the
// original checkbox/read-only body untouched.
export function PluginTrackRowList(props: PluginTrackRowListProps) {
  const libraryMode = !!props.selectable && !props.categories;
  return libraryMode
    ? <PluginTrackRowsSelectable {...props} />
    : <PluginTrackRowsLegacy {...props} />;
}

// Library-parity list: click/Cmd/Shift multi-select (no checkboxes), keyboard
// listbox navigation, double-click to play, and per-row hover overlay buttons
// built from the declared `actions` (so Download rides along automatically).
// Each overlay button applies its action to just that row via `selectedIds:
// [item.id]`, reusing the same handlers the toolbar fires for the selection.
function PluginTrackRowsSelectable({
  items,
  actions,
  numbered,
  showHeader,
  onAction,
  onContextMenu,
}: PluginTrackRowListProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeIndex, setActiveIndex] = useState(-1);
  const lastClickedIndexRef = useRef<number | null>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}opt${i}`;

  // Reset selection when the item set changes (e.g. a new search) so stale ids
  // never drive a bulk action against rows that are no longer shown.
  const prevKeyRef = useRef("");
  useEffect(() => {
    const key = (items[0]?.id ?? "") + ":" + items.length;
    if (prevKeyRef.current && prevKeyRef.current !== key) {
      setSelected(new Set());
      setActiveIndex(-1);
      lastClickedIndexRef.current = null;
    }
    prevKeyRef.current = key;
  }, [items]);

  // Cmd/Ctrl+A select-all and Escape clear, mirroring the library list.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (selected.size > 0) setSelected(new Set());
      } else if (e.key === "a" && (e.metaKey || e.ctrlKey) && items.length > 0) {
        if ((e.target as HTMLElement)?.closest("input, textarea, [contenteditable]")) return;
        e.preventDefault();
        setSelected(new Set(items.map(it => it.id)));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, items]);

  // Keep the keyboard cursor's row scrolled into view as it moves.
  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const selectAll = useCallback(() => setSelected(new Set(items.map(it => it.id))), [items]);
  const selectNone = useCallback(() => setSelected(new Set()), []);

  // Double-click / Enter play just that row: prefer its per-row `action`, else
  // fall back to the first declared action (the play action by convention).
  const playRow = useCallback((index: number) => {
    const item = items[index];
    if (!item) return;
    setSelected(new Set());
    if (item.action) onAction?.(item.action, { itemId: item.id });
    else if (actions && actions.length > 0) onAction?.(actions[0].id, { selectedIds: [item.id], itemId: item.id });
  }, [items, actions, onAction]);

  function handleRowClick(e: React.MouseEvent, index: number) {
    if ((e.target as HTMLElement).closest(".row-hover-action")) return;
    setSelected(computeRowSelection(selected, items, index, lastClickedIndexRef.current, e.metaKey || e.ctrlKey, e.shiftKey));
    lastClickedIndexRef.current = index;
    setActiveIndex(index);
  }

  function handleRowContextMenu(e: React.MouseEvent, index: number, item: TrackRowItem) {
    e.preventDefault();
    if (!selected.has(item.id)) {
      setSelected(new Set([item.id]));
      lastClickedIndexRef.current = index;
      setActiveIndex(index);
    }
    onContextMenu?.(e, item);
  }

  function moveActive(next: number, extend: boolean) {
    if (items.length === 0) return;
    const clamped = Math.max(0, Math.min(next, items.length - 1));
    setActiveIndex(clamped);
    if (extend) {
      setSelected(computeRowSelection(selected, items, clamped, lastClickedIndexRef.current, false, true));
    } else {
      setSelected(new Set([items[clamped].id]));
      lastClickedIndexRef.current = clamped;
    }
  }

  function handleListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget || items.length === 0) return;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); moveActive(activeIndex < 0 ? 0 : activeIndex + 1, e.shiftKey); break;
      case "ArrowUp": e.preventDefault(); moveActive(activeIndex < 0 ? 0 : activeIndex - 1, e.shiftKey); break;
      case "Home": e.preventDefault(); moveActive(0, e.shiftKey); break;
      case "End": e.preventDefault(); moveActive(items.length - 1, e.shiftKey); break;
      case "Enter": if (activeIndex >= 0) { e.preventDefault(); playRow(activeIndex); } break;
      case " ":
        if (activeIndex >= 0) {
          e.preventDefault();
          setSelected(computeRowSelection(selected, items, activeIndex, lastClickedIndexRef.current, true, false));
          lastClickedIndexRef.current = activeIndex;
        }
        break;
    }
  }

  function handleListFocus(e: React.FocusEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget && activeIndex < 0 && items.length > 0) setActiveIndex(0);
  }

  const useCv = items.length > 100;
  const hasActions = !!actions && actions.length > 0;

  return (
    <div className="ptr-list">
      <div className="ptr-toolbar">
        <div className="ptr-toolbar-left">
          <button className="ptr-toolbar-btn" onClick={selectAll}>All</button>
          <button className="ptr-toolbar-btn" onClick={selectNone}>None</button>
          <span className="ptr-toolbar-count">{selected.size} / {items.length}</span>
        </div>
        {hasActions && (
          <div className="ptr-toolbar-right">
            {actions!.map(a => (
              <button
                key={a.id}
                className="ptr-toolbar-btn"
                disabled={selected.size === 0}
                onClick={() => onAction?.(a.id, { selectedIds: Array.from(selected) })}
              >
                {a.icon && <span className="ptr-toolbar-icon">{a.icon}</span>}
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {showHeader && (
        <div className="ptr-header">
          {numbered && <span className="ptr-num">#</span>}
          <span className="ptr-art" />
          <span className="ptr-info ptr-header-title">Title</span>
          <span className="ptr-album">Album</span>
          <span className="ptr-duration">Duration</span>
        </div>
      )}
      <div
        className={`ptr-rows ptr-rows-selectable${useCv ? " ptr-rows-cv" : ""}`}
        role="listbox"
        aria-multiselectable="true"
        aria-label="Tracks"
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        tabIndex={0}
        onKeyDown={handleListKeyDown}
        onFocus={handleListFocus}
      >
        {items.map((item, i) => (
          <div
            key={item.id}
            role="option"
            id={optionId(i)}
            aria-selected={selected.has(item.id)}
            className={`ptr-row${selected.has(item.id) ? " ptr-row-selected" : ""}${activeIndex === i ? " ptr-row-active" : ""}`}
            onClick={(e) => handleRowClick(e, i)}
            onDoubleClick={() => playRow(i)}
            onContextMenu={onContextMenu ? (e) => handleRowContextMenu(e, i, item) : undefined}
          >
            {numbered && <span className="ptr-num">{i + 1}</span>}
            {item.imageUrl ? (
              <div className="ptr-art">
                <img src={resolveImageUrl(item.imageUrl)} alt="" loading="lazy" decoding="async" />
              </div>
            ) : showHeader ? (
              <div className="ptr-art" />
            ) : null}
            <div className="ptr-info">
              <span className="ptr-title">{item.title}</span>
              {item.subtitle && <span className="ptr-subtitle">{item.subtitle}</span>}
            </div>
            {showHeader && <span className="ptr-album">{item.album ?? ""}</span>}
            {item.duration && <span className="ptr-duration">{item.duration}</span>}
            {hasActions && (
              <span className="row-hover-actions">
                {actions!.map((a, ai) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`row-hover-action${ai === 0 ? " row-hover-action--play" : ""}`}
                    title={a.label}
                    aria-label={a.label}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onAction?.(a.id, { selectedIds: [item.id], itemId: item.id }); }}
                  >
                    {a.icon ? <span className="ptr-hover-glyph">{a.icon}</span> : <span className="ptr-hover-text">{a.label}</span>}
                  </button>
                ))}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PluginTrackRowsLegacy({
  items,
  selectable,
  actions,
  categories,
  numbered,
  showHeader,
  onAction,
  onContextMenu,
}: PluginTrackRowListProps) {
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
      {showHeader && (
        <div className="ptr-header">
          {numbered && <span className="ptr-num">#</span>}
          <span className="ptr-art" />
          <span className="ptr-info ptr-header-title">Title</span>
          <span className="ptr-album">Album</span>
          <span className="ptr-duration">Duration</span>
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
        numbered={numbered}
        showAlbum={showHeader}
        onAction={onAction}
        onContextMenu={onContextMenu}
      />
    </div>
  );
}

export function PluginTrackRowsBody({
  items,
  selected,
  toggleSelect,
  selectable,
  categories,
  itemCategories,
  toggleCategory,
  numbered,
  showAlbum,
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
  numbered?: boolean;
  showAlbum?: boolean;
  onAction?: (actionId: string, data?: unknown) => void;
  onContextMenu?: (e: React.MouseEvent, item: TrackRowItem) => void;
}) {
  // For long lists we apply `content-visibility: auto` per row via a CSS class.
  // The browser skips layout/paint for off-screen rows — same end result as
  // hand-rolled virtualization, no nested scroll containers, no flicker.
  const useCv = items.length > 100;
  return (
    <div className={`ptr-rows${useCv ? " ptr-rows-cv" : ""}`}>
      {items.map((item, i) => (
        <div
          key={item.id}
          className={`ptr-row${selected.has(item.id) ? " ptr-row-selected" : ""}`}
          onClick={() => item.action && onAction?.(item.action, { itemId: item.id })}
          onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, item); } : undefined}
        >
          {numbered && <span className="ptr-num">{i + 1}</span>}
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
          {item.imageUrl ? (
            <div className="ptr-art">
              <img src={resolveImageUrl(item.imageUrl)} alt="" loading="lazy" decoding="async" />
            </div>
          ) : showAlbum ? (
            // Album/table mode reserves the art column even when an item has no
            // image, so every row's columns line up (and align with the header).
            <div className="ptr-art" />
          ) : null}
          <div className="ptr-info">
            <span className="ptr-title">{item.title}</span>
            {item.subtitle && <span className="ptr-subtitle">{item.subtitle}</span>}
          </div>
          {showAlbum && <span className="ptr-album">{item.album ?? ""}</span>}
          {item.duration && <span className="ptr-duration">{item.duration}</span>}
        </div>
      ))}
    </div>
  );
}

// -- Loading --

export function PluginLoading({ message }: { message?: string }) {
  return (
    <div className="plugin-loading">
      <div className="plugin-loading-spinner" />
      {message && <div>{message}</div>}
    </div>
  );
}

// -- Confirm dialog --

export function PluginConfirm({
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

export function PluginToggle({
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

export function PluginSelect({
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

export function PluginProgressBar({
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

export function PluginSettingsRow({
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
