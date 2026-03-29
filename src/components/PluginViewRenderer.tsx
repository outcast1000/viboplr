import type { Track } from "../types";
import type { PluginViewData, CardGridItem, StatItem } from "../types/plugin";

interface PluginViewRendererProps {
  pluginName: string;
  data: PluginViewData | undefined;
  currentTrack: Track | null;
  onPlayTrack?: (track: Track) => void;
  onAction?: (actionId: string, data?: unknown) => void;
}

export function PluginViewRenderer({
  pluginName,
  data,
  currentTrack,
  onPlayTrack,
  onAction,
}: PluginViewRendererProps) {
  if (!data) {
    return (
      <div className="plugin-view">
        <div className="plugin-view-header">
          <h2>{pluginName}</h2>
        </div>
        <div className="plugin-view-empty">No content</div>
      </div>
    );
  }

  return (
    <div className="plugin-view">
      <div className="plugin-view-header">
        <h2>{pluginName}</h2>
      </div>
      <div className="plugin-view-content">
        <PluginViewNode
          node={data}
          currentTrack={currentTrack}
          onPlayTrack={onPlayTrack}
          onAction={onAction}
        />
      </div>
    </div>
  );
}

interface PluginViewNodeProps {
  node: PluginViewData;
  currentTrack: Track | null;
  onPlayTrack?: (track: Track) => void;
  onAction?: (actionId: string, data?: unknown) => void;
}

function PluginViewNode({
  node,
  currentTrack,
  onPlayTrack,
  onAction,
}: PluginViewNodeProps) {
  switch (node.type) {
    case "track-list":
      return (
        <PluginTrackList
          tracks={node.tracks}
          title={node.title}
          currentTrack={currentTrack}
          onDoubleClick={onPlayTrack}
        />
      );
    case "card-grid":
      return (
        <PluginCardGrid
          items={node.items}
          columns={node.columns}
          onAction={onAction}
        />
      );
    case "text":
      return <PluginText content={node.content} />;
    case "stats-grid":
      return <PluginStatsGrid items={node.items} />;
    case "button":
      return (
        <button
          className="plugin-button"
          onClick={() => onAction?.(node.action)}
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
            />
          ))}
        </div>
      );
    case "spacer":
      return <div className="plugin-spacer" />;
    default:
      return null;
  }
}

// -- Track List (simplified read-only) --

function PluginTrackList({
  tracks,
  title,
  currentTrack,
  onDoubleClick,
}: {
  tracks: Track[];
  title?: string;
  currentTrack: Track | null;
  onDoubleClick?: (track: Track) => void;
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
}: {
  items: CardGridItem[];
  columns?: number;
  onAction?: (actionId: string, data?: unknown) => void;
}) {
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
          className={`plugin-card${item.action ? " plugin-card-clickable" : ""}`}
          onClick={
            item.action
              ? () => onAction?.(item.action!, { itemId: item.id })
              : undefined
          }
        >
          {item.imageUrl && (
            <div className="plugin-card-image">
              <img src={item.imageUrl} alt={item.title} />
            </div>
          )}
          <div className="plugin-card-info">
            <div className="plugin-card-title">{item.title}</div>
            {item.subtitle && (
              <div className="plugin-card-subtitle">{item.subtitle}</div>
            )}
          </div>
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
  "br",
  "a",
  "ul",
  "ol",
  "li",
]);

function sanitizeHTML(html: string): string {
  // Strip tags not in allowlist
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tag) => {
    return ALLOWED_TAGS.has(tag.toLowerCase()) ? match : "";
  });
}

function PluginText({ content }: { content: string }) {
  // Check if content has HTML tags
  if (/<[a-zA-Z]/.test(content)) {
    return (
      <div
        className="plugin-text"
        dangerouslySetInnerHTML={{ __html: sanitizeHTML(content) }}
      />
    );
  }
  return <div className="plugin-text">{content}</div>;
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
