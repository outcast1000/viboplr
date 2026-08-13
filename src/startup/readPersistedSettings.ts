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
import type { VisualizerSlotSelection } from "../utils/visualizerSlots";

export interface PersistedSettings {
  vol: number | undefined;
  muted: boolean | undefined;
  crossfadeSecs: number | undefined;
  playbackEngine: string | undefined;
  audioExclusive: boolean | undefined;
  betaUpdates: boolean | undefined;
  telemetryEnabled: boolean | undefined;
  trackVideoHistory: boolean | undefined;
  preferVideoResolution: boolean | undefined;
  videoSubtitles: boolean | undefined;
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
  confirmTrashDelete: boolean | undefined;
  lastDownloadDest: string | null | undefined;
  searchViewModes: { tracks: ViewMode; albums: ViewMode; artists: ViewMode } | null | undefined;
  pluginViewMode: string | null | undefined;
  minimizeToMiniPlayer: boolean | undefined;
  reduceMotion: boolean | undefined;
  uiZoom: number | undefined;
  miniZoom: number | undefined;
  // EQ / ReplayGain — previously re-read per key by the restore effect after
  // this batch had already run (13 extra IPC round-trips before window.show()).
  eqEnabled: boolean | undefined;
  eqMode: string | undefined;
  eqPreset: string | undefined;
  eqGains: number[] | undefined;
  eqCustomPresets: { id: string; name: string; gains: number[] }[] | undefined;
  eqPreGainDb: number | undefined;
  eqBassDb: number | undefined;
  eqTrebleDb: number | undefined;
  eqShowBarControlSimple: boolean | undefined;
  eqShowBarControlAdvanced: boolean | undefined;
  rgMode: string | undefined;
  rgPreampDb: number | undefined;
  rgPreventClip: boolean | undefined;
  // Now Playing info / visualizer — previously five SEQUENTIAL awaits on the
  // first-paint critical path.
  nowPlayingInfoSelection: Record<string, boolean> | undefined;
  visualizerSlots: VisualizerSlotSelection | undefined;
  nowPlayingLyricsHidden: boolean | undefined;
  nowPlayingInfoPersistence: Record<string, number> | undefined;
  nowPlayingInfoOrder: string[] | undefined;
  // Debug / logging flags.
  loggingEnabled: boolean | undefined;
  debugLogging: boolean | undefined;
  debugMode: boolean | undefined;
  devPluginPath: string | null | undefined;
  autoUpdateManagedDeps: boolean | undefined;
}

/**
 * Batch-read all primary persisted settings. Startup intentionally does NOT
 * restore `view` or selected-entity state (always lands on Home), so those keys
 * are not read here. These are pure reads with no side effects.
 *
 * This pulls the whole store in ONE IPC round-trip via `store.entries()` rather
 * than one `store.get` per key (~29 IPCs, ~100ms on the first-paint critical
 * path). It is behaviorally identical to per-key `get`: the store's Rust cache
 * is seeded with the configured defaults and then overlaid with the on-disk
 * file, and both `get` and `entries` read that same merged cache — so a Map
 * built from `entries()` returns exactly what `get(key)` would, including
 * default-seeded keys, and `undefined` for keys absent from both. See
 * tauri-plugin-store `store.rs` (`cache` seeded from defaults; `load()` extends
 * it; `get`/`entries` both read `cache`).
 */
export async function readPersistedSettings(store: AppStore): Promise<PersistedSettings> {
  const map = new Map<string, unknown>(await store.entries());
  const read = <T>(key: string): T | undefined =>
    map.has(key) ? (map.get(key) as T) : undefined;
  return {
    vol: read<number>("volume"),
    muted: read<boolean>("muted"),
    crossfadeSecs: read<number>("crossfadeSecs"),
    playbackEngine: read<string>("playbackEngine"),
    audioExclusive: read<boolean>("audioExclusive"),
    betaUpdates: read<boolean>("betaUpdates"),
    telemetryEnabled: read<boolean>("telemetryEnabled"),
    trackVideoHistory: read<boolean>("trackVideoHistory"),
    preferVideoResolution: read<boolean>("preferVideoResolution"),
    // Kept under the legacy `videoLyricsOverlay` key for back-compat with saved
    // prefs (the overlay was formerly a theater-only "lyrics" toggle).
    videoSubtitles: read<boolean>("videoLyricsOverlay"),
    miniMode: read<boolean>("miniMode"),
    fullWindowWidth: read<number | null>("fullWindowWidth"),
    fullWindowHeight: read<number | null>("fullWindowHeight"),
    fullWindowX: read<number | null>("fullWindowX"),
    fullWindowY: read<number | null>("fullWindowY"),
    trackSortField: read<string | null>("trackSortField"),
    trackSortDir: read<string>("trackSortDir"),
    trackColumns: read<ColumnConfig[] | null>("trackColumns"),
    trackViewMode: read<string | null>("trackViewMode"),
    videoLayout: read<VideoLayoutState | null>("videoLayout"),
    sidebarCollapsed: read<boolean>("sidebarCollapsed"),
    queueCollapsed: read<boolean>("queueCollapsed"),
    queueWidth: read<number | null>("queueWidth"),
    mediaTypeFilter: read<string>("mediaTypeFilter"),
    trackLikedFirst: read<boolean>("trackLikedFirst"),
    confirmTrashDelete: read<boolean>("confirmTrashDelete"),
    lastDownloadDest: read<string | null>("lastDownloadDest"),
    searchViewModes: read<{ tracks: ViewMode; albums: ViewMode; artists: ViewMode } | null>("searchViewModes"),
    pluginViewMode: read<string | null>("pluginViewMode"),
    minimizeToMiniPlayer: read<boolean>("minimizeToMiniPlayer"),
    reduceMotion: read<boolean>("reduceMotion"),
    uiZoom: read<number>("uiZoom"),
    miniZoom: read<number>("miniZoom"),
    eqEnabled: read<boolean>("eqEnabled"),
    eqMode: read<string>("eqMode"),
    eqPreset: read<string>("eqPreset"),
    eqGains: read<number[]>("eqGains"),
    eqCustomPresets: read<{ id: string; name: string; gains: number[] }[]>("eqCustomPresets"),
    eqPreGainDb: read<number>("eqPreGainDb"),
    eqBassDb: read<number>("eqBassDb"),
    eqTrebleDb: read<number>("eqTrebleDb"),
    eqShowBarControlSimple: read<boolean>("eqShowBarControlSimple"),
    eqShowBarControlAdvanced: read<boolean>("eqShowBarControlAdvanced"),
    rgMode: read<string>("rgMode"),
    rgPreampDb: read<number>("rgPreampDb"),
    rgPreventClip: read<boolean>("rgPreventClip"),
    nowPlayingInfoSelection: read<Record<string, boolean>>("nowPlayingInfoSelection"),
    visualizerSlots: read<VisualizerSlotSelection>("visualizerSlots"),
    nowPlayingLyricsHidden: read<boolean>("nowPlayingLyricsHidden"),
    nowPlayingInfoPersistence: read<Record<string, number>>("nowPlayingInfoPersistence"),
    nowPlayingInfoOrder: read<string[]>("nowPlayingInfoOrder"),
    loggingEnabled: read<boolean>("loggingEnabled"),
    debugLogging: read<boolean>("debugLogging"),
    debugMode: read<boolean>("debugMode"),
    devPluginPath: read<string | null>("devPluginPath"),
    autoUpdateManagedDeps: read<boolean>("autoUpdateManagedDeps"),
  };
}
