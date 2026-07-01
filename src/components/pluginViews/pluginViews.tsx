// Leaf renderers for PluginViewData node types (split out of PluginViewRenderer.tsx).
// The recursive dispatcher PluginViewNode lives in PluginViewRenderer.tsx and
// imports these; none of these renderers recurse back into the dispatcher.
import { useState, useCallback, useEffect, useRef, useId } from "react";
import type { Track, QueueTrack } from "../../types";
import type { CardGridItem, StatItem, TrackRowItem, BarChartDatum, LineSeries, PluginMenuItem, PluginContextMenuTarget } from "../../types/plugin";
import { showNativeMenu, type MenuItemSpec } from "../../nativeMenu";
import { formatDuration, getInitials } from "../../utils";
import { computeSelection as computeSelectionGeneric } from "../../utils/rowSelection";
import { ViewSearchBar } from "../ViewSearchBar";
import { TrackRow } from "../TrackRow";
import { resolveImageUrl } from "../../utils/resolveImageUrl";
import { resolveTrackImage } from "../../utils/trackImage";
import { useImageCache } from "../../hooks/useImageCache";
import { sanitizeHTML } from "./htmlSanitize";
import {
  buildLinePath,
  buildAreaPath,
  formatChartValue,
  heatIntensity,
  type ChartValueFormat,
} from "../../utils/pluginCharts";

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
  // Right-click on a row. Passes the full selection (the right-clicked row plus
  // any other selected rows) so the host can build a single- or multi-track menu.
  onContextMenu?: (e: React.MouseEvent, items: TrackRowItem[]) => void;
  // Drag rows onto the queue panel. Receives the dragged rows (the selection if
  // the dragged row is part of a multi-selection, else just that row).
  onRowsDragStart?: (items: TrackRowItem[]) => void;
}

/**
 * Library-style click selection for plugin rows, keyed by item id + index.
 * Mirrors `TrackList.computeSelection`: a plain click replaces the selection,
 * Cmd/Ctrl+click toggles one item, Shift+click selects a range from the last
 * clicked index, and Cmd/Ctrl+Shift+click extends the existing selection with
 * that range. Exported for unit testing.
 */
// Thin adapter over the shared generic (src/utils/rowSelection.ts): maps the
// plugin rows to their string `id`s. Note the array-second argument order is
// preserved here (differs from the generic's array-third) so existing callers
// and computeRowSelection.test.ts stay unchanged.
export function computeRowSelection(
  current: Set<string>,
  items: { id: string }[],
  clickedIndex: number,
  lastIndex: number | null,
  meta: boolean,
  shift: boolean,
): Set<string> {
  return computeSelectionGeneric(current, clickedIndex, items.map(it => it.id), lastIndex, meta, shift);
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
  onRowsDragStart,
}: PluginTrackRowListProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeIndex, setActiveIndex] = useState(-1);
  const lastClickedIndexRef = useRef<number | null>(null);
  const didDragRef = useRef(false);
  const listId = useId();
  const optionId = (i: number) => `${listId}opt${i}`;

  // Name-based artwork, resolved exactly like the library/queue (album→artist),
  // so plugin rows show consistent thumbnails. The hooks subscribe to the image
  // cache, so rows re-render as fetched images arrive.
  const albumCache = useImageCache("album");
  const artistCache = useImageCache("artist");
  // Prime images with the lazy, idempotent `getImage` — NOT `requestFetch`.
  // `requestFetch` is a destructive force-refresh (wipes the cache entry, bumps
  // the cache-bust version, re-invokes fetch), so calling it on every `items`
  // change made the thumbnails flicker whenever a plugin re-emits its view data
  // rapidly (e.g. Library Statistics redrawing the Top list while it streams
  // play history). `getImage` returns the cached URL untouched and only kicks a
  // fetch on a genuine miss — so repeated redraws of an unchanged list are no-ops.
  useEffect(() => {
    for (const item of items) {
      if (item.imageUrl) continue;
      if (item.albumTitle) albumCache.getImage(item.albumTitle, item.artistName ?? undefined);
      else if (item.artistName) artistCache.getImage(item.artistName);
    }
    // getImage is stable (memoized on kind); re-run only when the item set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  const imageForRow = useCallback(
    (item: TrackRowItem): string | null =>
      resolveTrackImage(
        { title: item.title, artist_name: item.artistName, album_title: item.albumTitle, image_url: item.imageUrl },
        { albumImageFor: albumCache.getImage, artistImageFor: artistCache.getImage },
      ),
    [albumCache.getImage, artistCache.getImage],
  );

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
    if (didDragRef.current) return; // suppress the click that ends a drag
    if ((e.target as HTMLElement).closest(".row-hover-action")) return;
    setSelected(computeRowSelection(selected, items, index, lastClickedIndexRef.current, e.metaKey || e.ctrlKey, e.shiftKey));
    lastClickedIndexRef.current = index;
    setActiveIndex(index);
  }

  // Drag-to-queue: mirror the library list's mouse handshake (5px threshold,
  // selection-aware) so dragging plugin rows onto the queue inserts them.
  function handleRowMouseDown(e: React.MouseEvent, index: number) {
    if (e.button !== 0 || !onRowsDragStart) return;
    if ((e.target as HTMLElement).closest(".row-hover-action")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    didDragRef.current = false;

    function onMove(ev: MouseEvent) {
      if (didDragRef.current) return;
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
      didDragRef.current = true;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const item = items[index];
      const dragRows = selected.has(item.id) && selected.size > 1
        ? items.filter(it => selected.has(it.id))
        : [item];
      onRowsDragStart!(dragRows);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setTimeout(() => { didDragRef.current = false; }, 0);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleRowContextMenu(e: React.MouseEvent, index: number, item: TrackRowItem) {
    e.preventDefault();
    // Right-clicking inside a multi-selection targets the whole selection;
    // otherwise it selects (and targets) just the clicked row.
    let targetIds: Set<string>;
    if (selected.has(item.id) && selected.size > 1) {
      targetIds = selected;
    } else {
      targetIds = new Set([item.id]);
      setSelected(targetIds);
      lastClickedIndexRef.current = index;
      setActiveIndex(index);
    }
    onContextMenu?.(e, items.filter(it => targetIds.has(it.id)));
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
        {items.map((item, i) => {
          // Consistent thumbnail (image_url → album → artist by name), with a
          // first-letter placeholder on a miss — same chain as the library list.
          const art = imageForRow(item);
          return (
            <TrackRow
              key={item.id}
              // Dual class: `ptr-row` keeps the plugin list's row-level CSS
              // (content-visibility via `.ptr-rows-cv > .ptr-row`, selection fill,
              // keyboard accent-ring) while TrackRow supplies the .entity-list-*
              // internal structure. Selection/active state is carried by the
              // ptr-* classes here (not TrackRow's selected/active props).
              className={`ptr-row${selected.has(item.id) ? " ptr-row-selected" : ""}${activeIndex === i ? " ptr-row-active" : ""}`}
              role="option"
              id={optionId(i)}
              ariaSelected={selected.has(item.id)}
              leading={numbered ? <span className="ptr-num">{i + 1}</span> : undefined}
              thumb={art ? { kind: "image", url: art } : { kind: "initials", text: getInitials(item.title) }}
              title={item.title}
              subtitle={item.subtitle}
              column={showHeader ? <span className="ptr-album">{item.album ?? ""}</span> : undefined}
              meta={item.duration ? <span className="ptr-duration">{item.duration}</span> : undefined}
              onMouseDown={(e) => handleRowMouseDown(e, i)}
              onClick={(e) => handleRowClick(e, i)}
              onDoubleClick={() => playRow(i)}
              onContextMenu={onContextMenu ? (e) => handleRowContextMenu(e, i, item) : undefined}
              actions={hasActions ? {
                actions: actions!.map((a, ai) => ({
                  id: a.id,
                  label: a.label,
                  icon: a.icon,
                  isPlay: ai === 0,
                  onClick: () => onAction?.(a.id, { selectedIds: [item.id], itemId: item.id }),
                })),
              } : undefined}
            />
          );
        })}
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
        onContextMenu={onContextMenu ? (e, item) => onContextMenu(e, [item]) : undefined}
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

// -- Bar Chart --

export function PluginBarChart({
  bars,
  max,
  orientation = "horizontal",
  valueFormat,
  onAction,
}: {
  bars: BarChartDatum[];
  max?: number;
  orientation?: "horizontal" | "vertical";
  valueFormat?: ChartValueFormat;
  onAction?: (actionId: string, data?: unknown) => void;
}) {
  const scaleMax =
    max && max > 0 ? max : bars.reduce((m, b) => Math.max(m, b.value || 0), 0) || 1;

  // Bars opt into being clickable by carrying an `action`. We attach button
  // semantics (role/tabIndex/keyboard) so a clickable bar is reachable and
  // operable from the keyboard, matching the rest of the plugin view kinds.
  const clickProps = (b: BarChartDatum) =>
    b.action && onAction
      ? {
          role: "button",
          tabIndex: 0,
          onClick: () => onAction(b.action!, { id: b.id, label: b.label }),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onAction(b.action!, { id: b.id, label: b.label });
            }
          },
        }
      : {};

  if (orientation === "vertical") {
    return (
      <div className="plugin-bar-chart plugin-bar-chart--vertical">
        {/* Plot body: bars grow up from the baseline (the bottom border = x-axis). */}
        <div className="plugin-bar-cols">
          {bars.map((b, i) => {
            const pct = Math.max(0, Math.min(100, ((b.value || 0) / scaleMax) * 100));
            const clickable = !!(b.action && onAction);
            return (
              <div
                key={i}
                className={"plugin-bar-col" + (clickable ? " plugin-bar-col--clickable" : "")}
                title={`${b.label}: ${formatChartValue(b.value, valueFormat)}`}
                {...clickProps(b)}
              >
                <div className="plugin-bar-col-fill" style={{ height: `${pct}%`, background: b.color }}>
                  <span className="plugin-bar-col-value">{formatChartValue(b.value, valueFormat)}</span>
                </div>
              </div>
            );
          })}
        </div>
        {/* X-axis labels, below the baseline. */}
        <div className="plugin-bar-axis">
          {bars.map((b, i) => (
            <div key={i} className="plugin-bar-col-label" title={b.label}>
              {b.label}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="plugin-bar-chart">
      {bars.map((b, i) => {
        const pct = Math.max(0, Math.min(100, ((b.value || 0) / scaleMax) * 100));
        const clickable = !!(b.action && onAction);
        return (
          <div
            key={i}
            className={"plugin-bar-row" + (clickable ? " plugin-bar-row--clickable" : "")}
            {...clickProps(b)}
          >
            <div className="plugin-bar-label" title={b.label}>
              {b.label}
            </div>
            <div className="plugin-bar-track">
              <div className="plugin-bar-fill" style={{ width: `${pct}%`, background: b.color }} />
            </div>
            <div className="plugin-bar-value">
              {formatChartValue(b.value, valueFormat)}
              {b.sublabel ? <span className="plugin-bar-sublabel"> {b.sublabel}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// -- Heatmap (e.g. listening clock: hour-of-day × weekday) --

export function PluginHeatmap({
  rows,
  cols,
  cells,
  max,
  colLabelEvery = 1,
  valueSuffix = "",
}: {
  rows: string[];
  cols: string[];
  cells: number[][];
  max?: number;
  colLabelEvery?: number;
  valueSuffix?: string;
}) {
  const scaleMax =
    max && max > 0
      ? max
      : cells.reduce((m, row) => row.reduce((mm, v) => Math.max(mm, v || 0), m), 0) || 1;

  const nodes: React.ReactNode[] = [];
  nodes.push(<div key="corner" className="plugin-heatmap-corner" />);
  cols.forEach((c, ci) => {
    nodes.push(
      <div key={`col${ci}`} className="plugin-heatmap-collabel">
        {ci % colLabelEvery === 0 ? c : ""}
      </div>,
    );
  });
  rows.forEach((r, ri) => {
    nodes.push(
      <div key={`rl${ri}`} className="plugin-heatmap-rowlabel">
        {r}
      </div>,
    );
    cols.forEach((_c, ci) => {
      const v = (cells[ri] && cells[ri][ci]) || 0;
      const intensity = heatIntensity(v, scaleMax);
      const op = v > 0 ? Math.max(0.08, intensity) : 0;
      nodes.push(
        <div
          key={`cell${ri}-${ci}`}
          className="plugin-heatmap-cell"
          title={`${r} · ${cols[ci]}: ${v}${valueSuffix}`}
        >
          <div className="plugin-heatmap-cell-fill" style={{ opacity: op }} />
        </div>,
      );
    });
  });

  return (
    <div
      className="plugin-heatmap"
      style={{ gridTemplateColumns: `auto repeat(${cols.length}, minmax(0, 1fr))` }}
    >
      {nodes}
    </div>
  );
}

// -- Line Chart (trend over an ordered x-axis) --

export function PluginLineChart({
  series,
  labels,
  max,
  area,
  valueFormat,
}: {
  series: LineSeries[];
  labels?: string[];
  max?: number;
  area?: boolean;
  valueFormat?: ChartValueFormat;
}) {
  const W = 100;
  const H = 40;
  const allValues = series.reduce<number[]>((acc, s) => acc.concat(s.points), []);
  const scaleMax = max && max > 0 ? max : allValues.reduce((m, v) => Math.max(m, v || 0), 0) || 1;
  const gradId = "plc-" + useId().replace(/:/g, "");

  return (
    <div className="plugin-line-chart">
      <div className="plugin-line-chart-peak">{formatChartValue(scaleMax, valueFormat)}</div>
      <svg
        className="plugin-line-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {series.map((s, i) => (
          <g key={i}>
            {area && (
              <path
                d={buildAreaPath(s.points, scaleMax, W, H)}
                fill={`url(#${gradId})`}
                stroke="none"
              />
            )}
            <path
              d={buildLinePath(s.points, scaleMax, W, H)}
              fill="none"
              stroke={s.color || "var(--accent)"}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
      </svg>
      {labels && labels.length > 0 && (
        <div className="plugin-line-chart-labels">
          {labels.map((l, i) => (
            <span key={i} className="plugin-line-chart-label">
              {l}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
