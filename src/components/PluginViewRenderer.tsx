import { useRef, useLayoutEffect } from "react";
import type { Track, QueueTrack } from "../types";
import type { PluginViewData, TrackRowItem, PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";
import {
  PluginTrackList,
  PluginCardGrid,
  PluginText,
  PluginStatsGrid,
  PluginSearchInput,
  PluginTextInput,
  PluginTabs,
  PluginTrackRowList,
  PluginLoading,
  PluginConfirm,
  PluginToggle,
  PluginSelect,
  PluginProgressBar,
  PluginSettingsRow,
  PluginBarChart,
  PluginHeatmap,
  PluginLineChart,
} from "./pluginViews/pluginViews";
// Re-exported for existing consumers that import it from this module
// (renderers/HtmlRenderer, AnnotatedTextRenderer, RichTextRenderer).
export { sanitizeHTML } from "./pluginViews/htmlSanitize";
import "./PluginViewRenderer.css";
import { DetailHero } from "./DetailHero";
import { mapDetailHeaderToHeroProps } from "./pluginViews/mapDetailHeader";
import { resolveImageUrl } from "../utils/resolveImageUrl";

interface PluginViewRendererProps {
  pluginName: string;
  data: PluginViewData | undefined;
  scrollKey?: string;
  currentTrack: QueueTrack | null;
  onPlayTrack?: (track: Track) => void;
  onAction?: (actionId: string, data?: unknown) => void;
  onTrackContextMenu?: (e: React.MouseEvent, track: Track) => void;
  onTrackRowContextMenu?: (e: React.MouseEvent, items: TrackRowItem[]) => void;
  onTrackRowsDragStart?: (items: TrackRowItem[]) => void;
  pluginMenuItems?: PluginMenuItem[];
  onPluginAction?: (pluginId: string, actionId: string, target: PluginContextMenuTarget) => void;
}

export function PluginViewRenderer({
  data,
  scrollKey,
  currentTrack,
  onPlayTrack,
  onAction,
  onTrackContextMenu,
  onTrackRowContextMenu,
  onTrackRowsDragStart,
  pluginMenuItems,
  onPluginAction,
}: PluginViewRendererProps) {
  // Per-view scroll memory, keyed by scrollKey. Standard scroll-restoration
  // pattern: continuously record the CURRENT key's scrollTop via a scroll
  // listener (so the saved value is always up to date BEFORE any navigation —
  // we can't reliably read the outgoing position in a post-commit effect, since
  // the new view's content has already replaced the container's children), and
  // on key change just restore the incoming key's saved position (0 if unseen).
  // The [scrollKey] dep means the effect runs only when the key changes;
  // same-key updates (e.g. progressive in-place re-renders) do NOT re-run it, so
  // scroll position is naturally preserved. No key → no-op (legacy behavior).
  // Session-only; the position map is bounded to 50 keys.
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  const scrollPosRef = useRef<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    if (scrollKey === undefined) return;
    const el = scrollElRef.current;
    if (!el) return;
    // Restore the incoming view's saved position (top if first seen).
    el.scrollTop = scrollPosRef.current.get(scrollKey) ?? 0;
    // Record this view's scroll position as the user scrolls, so it's saved
    // before they navigate away. Re-insert (delete+set) to keep recently-used
    // keys newest for the size-bound eviction below.
    const onScroll = function () {
      var m = scrollPosRef.current;
      if (m.has(scrollKey)) m.delete(scrollKey);
      m.set(scrollKey, el.scrollTop);
      while (m.size > 50) {
        var oldest = m.keys().next().value;
        if (oldest === undefined) break;
        m.delete(oldest);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return function () { el.removeEventListener("scroll", onScroll); };
  }, [scrollKey]);

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
          onTrackRowsDragStart={onTrackRowsDragStart}
          pluginMenuItems={pluginMenuItems}
          onPluginAction={onPluginAction}
        />
      ))}
      <div className="plugin-view" ref={scrollElRef}>
        <div className="plugin-view-content">
          <PluginViewNode
            node={contentData}
            currentTrack={currentTrack}
            onPlayTrack={onPlayTrack}
            onAction={onAction}
            onTrackContextMenu={onTrackContextMenu}
            onTrackRowContextMenu={onTrackRowContextMenu}
            onTrackRowsDragStart={onTrackRowsDragStart}
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
  onTrackRowContextMenu?: (e: React.MouseEvent, items: TrackRowItem[]) => void;
  onTrackRowsDragStart?: (items: TrackRowItem[]) => void;
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
  onTrackRowsDragStart,
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
          numbered={node.numbered}
          showHeader={node.showHeader}
          onAction={onAction}
          onContextMenu={onTrackRowContextMenu}
          onRowsDragStart={onTrackRowsDragStart}
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
              onTrackRowsDragStart={onTrackRowsDragStart}
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
          buttonLabel={node.buttonLabel}
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
    case "bar-chart":
      return (
        <PluginBarChart
          bars={node.bars}
          max={node.max}
          orientation={node.orientation}
          valueFormat={node.valueFormat}
          onAction={onAction}
        />
      );
    case "heatmap":
      return (
        <PluginHeatmap
          rows={node.rows}
          cols={node.cols}
          cells={node.cells}
          max={node.max}
          colLabelEvery={node.colLabelEvery}
          valueSuffix={node.valueSuffix}
        />
      );
    case "line-chart":
      return (
        <PluginLineChart
          series={node.series}
          labels={node.labels}
          max={node.max}
          area={node.area}
          valueFormat={node.valueFormat}
        />
      );
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
              onTrackRowsDragStart={onTrackRowsDragStart}
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
                onTrackRowsDragStart={onTrackRowsDragStart}
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
    case "detail-header": {
      const hero = mapDetailHeaderToHeroProps(node, onAction);
      const artSrc = resolveImageUrl(node.imageUrl);
      const art = artSrc ? (
        <img
          src={artSrc}
          alt={node.title}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
      return (
        <DetailHero
          bgImages={hero.bgImages}
          art={art}
          artShape={hero.artShape}
          title={hero.title}
          entityLabel="album"
          meta={hero.meta}
          onPlay={hero.onPlay}
          onEnqueue={hero.onEnqueue}
          onBack={hero.onBack}
          overflowItems={hero.overflowItems}
        />
      );
    }
    default:
      return null;
  }
}
