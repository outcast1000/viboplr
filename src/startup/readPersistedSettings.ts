// Pure reader for persisted startup settings, extracted from App.tsx.
//
// Previously App.tsx restored these via a 46-element positional tuple destructure
// (with `, , ,` gaps and dead `void` reads kept only to preserve tuple shape).
// This collapses the reads into a single batched Promise.all returning a named
// object, killing the positional-index footgun. It performs NO state mutation —
// App.tsx still owns applying these values to its hooks/setters.
import type { AppStore } from "../store";
import type { ViewMode, ColumnConfig } from "../types";
import type { VideoLayoutState } from "../hooks/useVideoLayout";

export interface PersistedSettings {
  vol: number | undefined;
  muted: boolean | undefined;
  crossfadeSecs: number | undefined;
  trackVideoHistory: boolean | undefined;
  miniMode: boolean | undefined;
  fullWindowWidth: number | null | undefined;
  fullWindowHeight: number | null | undefined;
  fullWindowX: number | null | undefined;
  fullWindowY: number | null | undefined;
  trackSortField: string | null | undefined;
  trackSortDir: string | undefined;
  trackColumns: ColumnConfig[] | null | undefined;
  trackViewMode: string | null | undefined;
  videoLayout: VideoLayoutState | null | undefined;
  sidebarCollapsed: boolean | undefined;
  queueCollapsed: boolean | undefined;
  queueWidth: number | null | undefined;
  mediaTypeFilter: string | undefined;
  trackLikedFirst: boolean | undefined;
  lastDownloadDest: string | null | undefined;
  searchViewModes: { tracks: ViewMode; albums: ViewMode; artists: ViewMode } | null | undefined;
  pluginViewMode: string | null | undefined;
  minimizeToMiniPlayer: boolean | undefined;
  reduceMotion: boolean | undefined;
  uiZoom: number | undefined;
  miniZoom: number | undefined;
}

/**
 * Batch-read all primary persisted settings. Startup intentionally does NOT
 * restore `view` or selected-entity state (always lands on Home), so those keys
 * are not read here. `store.get` is a pure read with no side effects.
 */
export async function readPersistedSettings(store: AppStore): Promise<PersistedSettings> {
  const [
    vol, muted, crossfadeSecs, trackVideoHistory, miniMode,
    fullWindowWidth, fullWindowHeight, fullWindowX, fullWindowY,
    trackSortField, trackSortDir, trackColumns, trackViewMode,
    videoLayout, sidebarCollapsed, queueCollapsed, queueWidth,
    mediaTypeFilter, trackLikedFirst,
    lastDownloadDest, searchViewModes, pluginViewMode,
    minimizeToMiniPlayer, reduceMotion, uiZoom, miniZoom,
  ] = await Promise.all([
    store.get<number>("volume"),
    store.get<boolean>("muted"),
    store.get<number>("crossfadeSecs"),
    store.get<boolean>("trackVideoHistory"),
    store.get<boolean>("miniMode"),
    store.get<number | null>("fullWindowWidth"),
    store.get<number | null>("fullWindowHeight"),
    store.get<number | null>("fullWindowX"),
    store.get<number | null>("fullWindowY"),
    store.get<string | null>("trackSortField"),
    store.get<string>("trackSortDir"),
    store.get<ColumnConfig[] | null>("trackColumns"),
    store.get<string | null>("trackViewMode"),
    store.get<VideoLayoutState | null>("videoLayout"),
    store.get<boolean>("sidebarCollapsed"),
    store.get<boolean>("queueCollapsed"),
    store.get<number | null>("queueWidth"),
    store.get<string>("mediaTypeFilter"),
    store.get<boolean>("trackLikedFirst"),
    store.get<string | null>("lastDownloadDest"),
    store.get<{ tracks: ViewMode; albums: ViewMode; artists: ViewMode } | null>("searchViewModes"),
    store.get<string | null>("pluginViewMode"),
    store.get<boolean>("minimizeToMiniPlayer"),
    store.get<boolean>("reduceMotion"),
    store.get<number>("uiZoom"),
    store.get<number>("miniZoom"),
  ]);
  return {
    vol, muted, crossfadeSecs, trackVideoHistory, miniMode,
    fullWindowWidth, fullWindowHeight, fullWindowX, fullWindowY,
    trackSortField, trackSortDir, trackColumns, trackViewMode,
    videoLayout, sidebarCollapsed, queueCollapsed, queueWidth,
    mediaTypeFilter, trackLikedFirst,
    lastDownloadDest, searchViewModes, pluginViewMode,
    minimizeToMiniPlayer, reduceMotion, uiZoom, miniZoom,
  };
}
