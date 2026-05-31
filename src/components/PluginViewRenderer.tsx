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
