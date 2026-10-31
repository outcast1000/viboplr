// Pure reader for the persisted startup settings the restore applies by hand.
//
// Most settings are NOT here: a `usePersistedSetting` restores itself from the
// same snapshot (`hydratePersistedSettings`). What remains is state owned by
// another hook (playback volume / EQ / ReplayGain, the library's sort and
// columns, zoom, window geometry, the video layout), plain `useState` in App
// (crossfade, last download folder), retired keys read only to migrate them,
// and the few settings whose restore has a side effect (audio exclusive,
// telemetry, reduce motion, debug logging). It performs NO state mutation.
import type { AppStore } from "../store";
import type { ColumnConfig } from "../types";
import type { VideoLayoutState } from "../hooks/useVideoLayout";

export interface PersistedSettings {
  vol: number | undefined;
  muted: boolean | undefined;
  crossfadeSecs: number | undefined;
  audioExclusive: boolean | undefined;
  betaUpdates: boolean | undefined;
  telemetryEnabled: boolean | undefined;
  /** Legacy single video switch for every scrobbler — read only to migrate
   *  into `scrobbleSettings` (utils/scrobblers.ts). */
  trackVideoHistory: boolean | undefined;
  /** Coerced by App (`coerceScrobbleSettings`). */
  scrobbleSettings: unknown;
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
  mediaTypeFilter: string | undefined;
  trackLikedFirst: boolean | undefined;
  lastDownloadDest: string | null | undefined;
  reduceMotion: boolean | undefined;
  scrollLongTitles: boolean | undefined;
  /** Retired mini-only predecessor of `scrollLongTitles`; written only when
   *  the user toggled it, so a stored value is an explicit choice. */
  legacyMiniTitleScroll: boolean | undefined;
  uiZoom: number | undefined;
  miniZoom: number | undefined;
  // EQ / ReplayGain — previously re-read per key by the restore effect after
  // this batch had already run (13 extra IPC round-trips before window.show()).
  eqEnabled: boolean | undefined;
  eqMode: string | undefined;
  eqPreset: string | undefined;
  eqGains: number[] | undefined;
  eqPreGainDb: number | undefined;
  eqBassDb: number | undefined;
  eqTrebleDb: number | undefined;
  eqClipProtection: string | undefined;
  rgMode: string | undefined;
  rgPreampDb: number | undefined;
  rgPreventClip: boolean | undefined;
  debugLogging: boolean | undefined;
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
 *
 * The same snapshot feeds `persistedSettingsFrom` and `hydratePersistedSettings`.
 */
export async function readStoreSnapshot(store: AppStore): Promise<Map<string, unknown>> {
  return new Map<string, unknown>(await store.entries());
}

export async function readPersistedSettings(store: AppStore): Promise<PersistedSettings> {
  return persistedSettingsFrom(await readStoreSnapshot(store));
}

/** The hand-applied settings, out of a snapshot from `readStoreSnapshot`. */
export function persistedSettingsFrom(map: ReadonlyMap<string, unknown>): PersistedSettings {
  const read = <T>(key: string): T | undefined =>
    map.has(key) ? (map.get(key) as T) : undefined;
  return {
    vol: read<number>("volume"),
    muted: read<boolean>("muted"),
    crossfadeSecs: read<number>("crossfadeSecs"),
    audioExclusive: read<boolean>("audioExclusive"),
    betaUpdates: read<boolean>("betaUpdates"),
    telemetryEnabled: read<boolean>("telemetryEnabled"),
    trackVideoHistory: read<boolean>("trackVideoHistory"),
    scrobbleSettings: read<unknown>("scrobbleSettings"),
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
    mediaTypeFilter: read<string>("mediaTypeFilter"),
    trackLikedFirst: read<boolean>("trackLikedFirst"),
    lastDownloadDest: read<string | null>("lastDownloadDest"),
    reduceMotion: read<boolean>("reduceMotion"),
    scrollLongTitles: read<boolean>("scrollLongTitles"),
    legacyMiniTitleScroll: read<boolean>("miniTitleScroll"),
    uiZoom: read<number>("uiZoom"),
    miniZoom: read<number>("miniZoom"),
    eqEnabled: read<boolean>("eqEnabled"),
    eqMode: read<string>("eqMode"),
    eqPreset: read<string>("eqPreset"),
    eqGains: read<number[]>("eqGains"),
    eqPreGainDb: read<number>("eqPreGainDb"),
    eqBassDb: read<number>("eqBassDb"),
    eqTrebleDb: read<number>("eqTrebleDb"),
    eqClipProtection: read<string>("eqClipProtection"),
    rgMode: read<string>("rgMode"),
    rgPreampDb: read<number>("rgPreampDb"),
    rgPreventClip: read<boolean>("rgPreventClip"),
    debugLogging: read<boolean>("debugLogging"),
  };
}
