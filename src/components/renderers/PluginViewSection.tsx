import type { InfoEntity } from "../../types/informationTypes";
import type { PluginViewData } from "../../types/plugin";
import { PluginViewRenderer } from "../PluginViewRenderer";
import { usePluginSectionHost } from "../../contexts/PluginSectionContext";

/** The tree a `plugin_view` value holds: the value itself, or its `view`
 *  field. Anything else (an empty or malformed value) draws nothing. */
export function pluginViewTree(value: unknown): PluginViewData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const tree = typeof v.type === "string" ? v : v.view;
  return tree && typeof tree === "object" && typeof (tree as { type?: unknown }).type === "string"
    ? (tree as unknown as PluginViewData)
    : undefined;
}

/** An action's payload as the plugin receives it: whatever the node sent,
 *  plus the entity whose page it was clicked on. A non-object payload rides
 *  as `value`, the way inputs report theirs. */
export function sectionActionPayload(data: unknown, entity: InfoEntity | null): Record<string, unknown> {
  const base: Record<string, unknown> =
    data && typeof data === "object" && !Array.isArray(data) ? { ...(data as Record<string, unknown>) } : data === undefined ? {} : { value: data };
  if (entity) {
    base.entity = { kind: entity.kind, name: entity.name, artistName: entity.artistName ?? null, albumTitle: entity.albumTitle ?? null };
  }
  return base;
}

interface Props {
  data: unknown;
  pluginId: string | undefined;
  pluginName: string;
  entity: InfoEntity | null;
}

/**
 * An interactive information section: the plugin's own view tree, inside a
 * detail page's tab. It goes through the same sanitising renderer as a plugin's
 * sidebar view, so a tab can do nothing a view can't — no raw HTML.
 */
export function PluginViewSection({ data, pluginId, pluginName, entity }: Props) {
  const host = usePluginSectionHost();
  const tree = pluginViewTree(data);
  if (!tree) return <div className="info-section-empty">No data available</div>;
  return (
    <div className="info-plugin-view">
      <PluginViewRenderer
        pluginName={pluginName}
        data={tree}
        currentTrack={host?.currentTrack ?? null}
        playing={host?.playing ?? false}
        onAction={(actionId, actionData) => {
          if (host && pluginId) host.dispatch(pluginId, actionId, sectionActionPayload(actionData, entity));
        }}
        // Track rows act as they do in the plugin's sidebar views: play, the
        // track menus (every plugin's items included), drag to the queue.
        onPlayTrack={host?.tracks?.onPlayTrack}
        onTrackContextMenu={host?.tracks?.onTrackContextMenu}
        onTrackRowContextMenu={host?.tracks?.onTrackRowContextMenu}
        onTrackRowsDragStart={host?.tracks?.onTrackRowsDragStart}
        pluginMenuItems={host?.tracks?.pluginMenuItems}
        onPluginAction={host?.tracks?.onPluginAction}
      />
    </div>
  );
}
