// Startup restore: everything the app brings back from the last session,
// from `store.init()` to the window being shown and the saved queue applied.
//
// Two phases, both here so the hand-off between them stays private:
//   1. On mount: read the store once, let every `usePersistedSetting` restore
//      itself (`hydratePersistedSettings`), apply the rest by hand, read the
//      saved queue, show the window, then flip `appRestoring` false.
//   2. Once `appRestoring` is false: apply the saved queue and current track,
//      then call `onRestoreApplied` — the point after which work that would
//      otherwise clobber the saved queue (a profile switch, a launch-time
//      mixtape or app link) is safe.
//
// A setting needs a line here only when it is NOT a `usePersistedSetting`
// (state owned by another hook, or plain useState) or when restoring it has a
// side effect or a migration. Everything else restores itself.
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { store, RETIRED_STORE_KEYS } from "../store";
import { timeAsync, getTimingEntries } from "../startupTiming";
import { readStoreSnapshot, persistedSettingsFrom } from "./readPersistedSettings";
import { restoreMainPlaylist } from "./restoreMainPlaylist";
import { reportStartupTelemetry } from "./startupTelemetry";
import { hydratePersistedSettings } from "../hooks/usePersistedSetting";
import { useLatestRef } from "../hooks/useLatestRef";
import { probeEngineCapabilities, nativeEngine, type EngineCapabilities } from "../playback/nativeEngine";
import { setTelemetryEnabled as syncTelemetryEnabled } from "../telemetry";
import { applyReduceMotionAttr } from "../utils/reducedMotion";
import { coerceScrobbleSettings, type ScrobbleSettings } from "../utils/scrobblers";
import { applyWebviewZoom } from "../utils/zoom";
import { DEFAULT_TRACK_COLUMNS, type useLibrary } from "../hooks/useLibrary";
import type { usePlayback } from "../hooks/usePlayback";
import type { useQueue } from "../hooks/useQueue";
import type { useMiniMode } from "../hooks/useMiniMode";
import type { useVideoLayout } from "../hooks/useVideoLayout";
import type { useUiZoom } from "../hooks/useUiZoom";
import type { Notify } from "../hooks/useToasts";
import type { ColumnConfig, QueueTrack, SortField, SortDir, ViewMode } from "../types";

const SORT_FIELDS: readonly SortField[] = ["num", "title", "artist", "album", "duration", "path", "year", "quality", "size", "collection", "added", "modified", "random"];
const VIEW_MODES: readonly string[] = ["basic", "list", "tiles"];
const MEDIA_FILTERS: readonly string[] = ["all", "audio", "video"];
const EQ_GAIN_BANDS = 10;
/** How long the restore waits for the libmpv probe before showing the app anyway. */
const ENGINE_PROBE_BUDGET_MS = 5000;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export interface RestoreSessionDeps {
  restoredRef: React.RefObject<boolean>;
  appRestoring: boolean;
  setAppRestoring: (restoring: boolean) => void;
  playback: ReturnType<typeof usePlayback>;
  library: ReturnType<typeof useLibrary>;
  queueHook: ReturnType<typeof useQueue>;
  mini: ReturnType<typeof useMiniMode>;
  zoom: ReturnType<typeof useUiZoom>;
  videoLayout: ReturnType<typeof useVideoLayout>;
  notify: Notify;
  applyEngineCapabilities: (caps: EngineCapabilities) => void;
  /** App-owned plain state the store restores into. */
  setCrossfadeSecs: (secs: number) => void;
  setLastDownloadDest: (dest: string | null) => void;
  setScrobbleSettings: (settings: ScrobbleSettings) => void;
  setScrollLongTitles: (on: boolean) => void;
  setDebugLoggingRef: (on: boolean) => void;
  /** Runs once, after the saved queue and track are applied. */
  onRestoreApplied: () => void;
}

export function useRestoreSession(deps: RestoreSessionDeps): void {
  // Read through a ref: the mount effect outlives the render it started in,
  // and phase 2 must call the newest `onRestoreApplied`.
  const depsRef = useLatestRef(deps);
  // Phase 1 → phase 2 hand-off: filled while hidden, applied once restoring ends.
  const pendingQueueRef = useRef<{ tracks: QueueTrack[]; index: number } | null>(null);
  const pendingThumbsRef = useRef<Array<[string, string]>>([]);

  useEffect(() => {
    (async () => {
      const d = depsRef.current;
      const { playback, library, queueHook, mini, zoom, videoLayout } = d;
      // Kick off the mpv capability probe now, in parallel with the rest of
      // restore below — it's awaited (never rejects; probeEngineCapabilities
      // catches internally) right before appRestoring flips false, so
      // mpvCapable/mpvVideoCapable are settled by the time the restored
      // queue/track become playable. Without this, the first play after
      // launch could read a stale mpvCapable=false and fail with "the
      // playback engine couldn't start".
      const engineCapabilityPromise = probeEngineCapabilities().then(d.applyEngineCapabilities);
      try {
        await timeAsync("store.init", () => store.init());
        // Startup always lands on Home; `view` and selected-entity state are
        // intentionally not restored (see readPersistedSettings).
        const snapshot = await timeAsync("store.restore", () => readStoreSnapshot(store));
        hydratePersistedSettings(snapshot);
        const s = persistedSettingsFrom(snapshot);
        for (const key of RETIRED_STORE_KEYS) {
          store.delete(key).catch((e) => console.error(`Failed to drop retired store key ${key}:`, e));
        }

        // ── Side effects of settings that restored themselves ──
        if (s.audioExclusive === true) {
          // Cached engine-side until the engine exists; no-op where libmpv
          // couldn't be loaded.
          nativeEngine.setAudioExclusive(true).catch(console.error);
        }
        if (s.reduceMotion === true) applyReduceMotionAttr(true);
        if (s.debugLogging === true) d.setDebugLoggingRef(true);
        // Anonymous usage telemetry (opt-out; see telemetry.ts). Absent key ⇒ on.
        const telemetryOn = s.telemetryEnabled !== false;
        syncTelemetryEnabled(telemetryOn);
        if (telemetryOn) {
          reportStartupTelemetry(s.betaUpdates === true)
            .catch((e) => console.error("Failed to report startup telemetry:", e));
        }

        // ── Migrations from retired keys ──
        // Restore doesn't persist (restoredRef is still false), so a migrated
        // value is written once here — after that the old key is never read.
        if (s.scrobbleSettings == null && typeof s.trackVideoHistory === "boolean") {
          const migrated = coerceScrobbleSettings(undefined, s.trackVideoHistory);
          d.setScrobbleSettings(migrated);
          store.set("scrobbleSettings", migrated)
            .catch((e) => console.error("Failed to persist migrated scrobbleSettings:", e));
        }
        // A user who explicitly turned the old mini-only title scroll back on keeps it.
        if (s.scrollLongTitles === undefined && s.legacyMiniTitleScroll === true) {
          d.setScrollLongTitles(true);
          store.set("scrollLongTitles", true).catch((e) => console.error("Failed to migrate miniTitleScroll:", e));
        }

        // ── State owned elsewhere ──
        zoom.hydrate(s.uiZoom, s.miniZoom);
        if (s.vol != null) playback.setVolume(s.vol);
        if (s.muted != null) {
          playback.setMuted(s.muted);
          // Restoring a muted state means the app starts silent — say so, so
          // the silence isn't mistaken for a playback bug.
          if (s.muted) d.notify("Audio is muted from your last session");
        }
        if (s.crossfadeSecs != null) d.setCrossfadeSecs(s.crossfadeSecs);
        if (s.lastDownloadDest !== undefined) d.setLastDownloadDest(s.lastDownloadDest ?? null);

        if (typeof s.eqEnabled === "boolean") playback.setEqEnabled(s.eqEnabled);
        if (s.eqMode === "simple" || s.eqMode === "advanced") playback.setEqMode(s.eqMode);
        if (s.rgMode === "off" || s.rgMode === "track" || s.rgMode === "album") playback.setRgMode(s.rgMode);
        if (typeof s.rgPreampDb === "number") playback.setRgPreampDb(s.rgPreampDb);
        if (typeof s.rgPreventClip === "boolean") playback.setRgPreventClip(s.rgPreventClip);
        if (typeof s.eqPreset === "string") playback.setEqPreset(s.eqPreset);
        if (Array.isArray(s.eqGains) && s.eqGains.length === EQ_GAIN_BANDS && s.eqGains.every(n => typeof n === "number")) {
          playback.setEqGains(s.eqGains);
        }
        if (finite(s.eqPreGainDb)) playback.setEqPreGainDb(s.eqPreGainDb);
        if (finite(s.eqBassDb)) playback.setEqBassDb(s.eqBassDb);
        if (finite(s.eqTrebleDb)) playback.setEqTrebleDb(s.eqTrebleDb);
        if (s.eqClipProtection === "limiter" || s.eqClipProtection === "headroom") {
          playback.setEqClipProtection(s.eqClipProtection);
        }

        if (s.trackSortField && (SORT_FIELDS as readonly string[]).includes(s.trackSortField)) library.setSortField(s.trackSortField as SortField);
        if (s.trackSortDir === "asc" || s.trackSortDir === "desc") library.setSortDir(s.trackSortDir as SortDir);
        if (Array.isArray(s.trackColumns) && s.trackColumns.length > 0) {
          // Merge in any columns added since the config was saved.
          const savedIds = new Set(s.trackColumns.map((c: ColumnConfig) => c.id));
          const missing = DEFAULT_TRACK_COLUMNS.filter(c => !savedIds.has(c.id));
          library.setTrackColumns([...s.trackColumns, ...missing]);
        }

        await timeAsync("queue.restore", async () => {
          try {
            const saved = await restoreMainPlaylist(invoke);
            pendingQueueRef.current = saved.queue;
            pendingThumbsRef.current = saved.thumbs;
            if (saved.context) queueHook.setPlaylistContext(saved.context);
            if (saved.mode) queueHook.setQueueMode(saved.mode);
            // Fire-and-forget gc; not awaited so it never blocks startup.
            invoke("main_playlist_gc").catch(e => console.error("main_playlist_gc failed:", e));
          } catch (e) {
            console.error("Failed to restore main playlist:", e);
          }
        });

        if (s.trackViewMode && VIEW_MODES.includes(s.trackViewMode)) library.setTrackViewMode(s.trackViewMode as ViewMode);
        if (s.mediaTypeFilter && MEDIA_FILTERS.includes(s.mediaTypeFilter)) library.setMediaTypeFilter(s.mediaTypeFilter as "all" | "audio" | "video");
        if (s.trackLikedFirst) library.setTrackLikedFirst(true);
        if (s.videoLayout) videoLayout.restoreLayout(s.videoLayout);
        // Startup always lands on Home — track detail / fallback state is intentionally not restored.

        await timeAsync("window.restore", async () => {
          // Size/position already restored by Rust setup — just set React state and show.
          const wasMini = s.miniMode === true;
          if (wasMini) {
            const { fullWindowWidth: w, fullWindowHeight: h } = s;
            if (w && h) mini.fullSizeRef.current = { w, h, x: s.fullWindowX ?? 0, y: s.fullWindowY ?? 0 };
            mini.setMiniMode(true);
            mini.miniModeRef.current = true;
          }
          // Apply the saved interface zoom for the restored mode before showing,
          // so the first paint lands at the right size (webview zoom doesn't
          // persist across restarts). hydrate() clamped these to the ladder.
          await applyWebviewZoom(wasMini ? zoom.miniZoomRef.current : zoom.uiZoomRef.current);
          // Rust sized the mini window from hardcoded logical-px constants
          // before this webview existed (lib.rs). Refit it against the page's
          // own measured scale while still hidden, so a platform where CSS and
          // logical pixels disagree doesn't come up clipped (issue #130).
          if (wasMini) await mini.refitMiniWindow();
          await getCurrentWindow().show();
        });
      } catch (e) {
        console.error("Failed to restore state:", e);
        await getCurrentWindow().show();
      }
      // Bounded: a slow or stalled libmpv load (native dlopen at startup) must
      // never wedge the whole restore behind it — queue/track restoration and
      // library load both happen after this point. On timeout, mpvCapable
      // simply settles a moment later via the same promise's
      // applyEngineCapabilities callback (still attached, still running) and
      // only a play in that window fails with "the playback engine couldn't start".
      await timeAsync("engineCapabilities", () =>
        Promise.race([
          engineCapabilityPromise,
          new Promise<void>((resolve) => setTimeout(resolve, ENGINE_PROBE_BUDGET_MS)),
        ])
      );
      d.restoredRef.current = true;
      d.setAppRestoring(false);
      await timeAsync("loadLibrary", () => depsRef.current.library.loadLibrary());
      // Persist the frontend startup timings to the on-disk log so every cold
      // start leaves a cross-session record of the perceived-startup path.
      // The window is already visible by now, so this never gates first paint.
      invoke("record_frontend_startup_timings", { entries: getTimingEntries() })
        .catch(e => console.error("Failed to log frontend startup timings:", e));
    })();
    // Mount-only: everything it needs is read through depsRef.
  }, [depsRef]);

  const { appRestoring } = deps;
  useEffect(() => {
    if (appRestoring) return;
    const { playback, queueHook, onRestoreApplied } = depsRef.current;
    const queue = pendingQueueRef.current;
    if (queue) {
      pendingQueueRef.current = null;
      const track = queue.index >= 0 ? queue.tracks[queue.index] : null;
      if (track) {
        playback.setCurrentTrack(track);
        playback.setDurationSecs(track.duration_secs ?? 0);
      }
      queueHook.setQueue(queue.tracks);
      queueHook.setQueueIndex(queue.index);
      // Seed thumbnails cached before restart synchronously with the queue.
      // The backend already existence-checked each thumb and returned its
      // canonical_slug-derived filename, so rows paint cached art on the first
      // render with no async round-trip and Rust stays the sole namer of the file.
      queueHook.seedThumbInfo(pendingThumbsRef.current);
      pendingThumbsRef.current = [];
    }
    onRestoreApplied();
  }, [appRestoring, depsRef]);
}
