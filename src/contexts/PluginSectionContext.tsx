import { createContext, useContext, type MouseEvent } from "react";
import type { QueueTrack, Track } from "../types";
import type { PluginContextMenuTarget, PluginMenuItem, TrackRowItem } from "../types/plugin";

/** What a plugin view's track rows do — play, the track menus (with every
 *  plugin's items), drag to the queue. One set, shared by sidebar views and
 *  tabs, so a track looks and acts the same wherever a plugin draws it. */
export interface PluginTrackHandlers {
  onPlayTrack: (track: Track) => void;
  onTrackContextMenu: (e: MouseEvent, track: Track) => void;
  onTrackRowContextMenu: (e: MouseEvent, items: TrackRowItem[]) => void;
  onTrackRowsDragStart: (items: TrackRowItem[]) => void;
  /** Cards' pass-through menus: the plugin items, already filtered by the
   *  user's Contributions toggles (`plugins.menuItems`). */
  pluginMenuItems: PluginMenuItem[];
  onPluginAction: (pluginId: string, actionId: string, target: PluginContextMenuTarget) => void;
}

/**
 * What an interactive (`plugin_view`) information section needs from the host:
 * where its actions go (the drawing plugin's `api.ui.onAction`) and the live
 * transport state `PluginViewRenderer` threads to its nodes.
 *
 * A context of its own rather than a field on `DetailViewActions`, because
 * information sections also render outside detail pages and this must be
 * optional: without a provider a `plugin_view` tab still draws, its buttons
 * just do nothing.
 */
export interface PluginSectionHost {
  dispatch: (pluginId: string, actionId: string, data: unknown) => void;
  currentTrack: QueueTrack | null;
  playing: boolean;
  /** Absent: track rows draw, but don't play or open a menu. */
  tracks?: PluginTrackHandlers;
}

export const PluginSectionContext = createContext<PluginSectionHost | null>(null);

export function usePluginSectionHost(): PluginSectionHost | null {
  return useContext(PluginSectionContext);
}
