// Typed bridge to the native mpv playback engine. The engine is compiled
// into every build; libmpv itself is loaded at runtime (bundled with the
// Full build, or downloaded on demand as the "engine component" — see
// Settings > Playback). Capability is probed via `engine_capabilities` and
// cached; `refreshEngineCapabilities` re-probes after a component install,
// which the backend picks up without a restart. All control methods silently
// no-op when incapable; only `play` requires the caller to have checked
// capability first (usePlayback gates on it).

import { invoke } from "@tauri-apps/api/core";
import type { EngineSource } from "../types";

export interface EnginePositionEvent {
  trackKey: string;
  positionSecs: number;
  durationSecs: number | null;
}

export interface EngineDurationEvent {
  trackKey: string;
  durationSecs: number;
}

export interface EngineTrackChangedEvent {
  trackKey: string;
  reason: "gapless" | "crossfade";
}

export interface EngineEndedEvent {
  trackKey: string;
}

export interface EngineStateEvent {
  playing: boolean;
  trackKey: string | null;
}

export interface EngineErrorEvent {
  trackKey: string;
  code: "decode" | "io" | "device" | string;
  message: string;
}

/** mpv media-title updates — ICY StreamTitle for live radio streams. Local
 * files emit their tag title once; consumers drop titles equal to the
 * track's own. */
export interface EngineIcyTitleEvent {
  trackKey: string;
  title: string;
}

/** Live facts about what the engine is decoding (works for remote streams). */
export interface EngineAudioInfo {
  codec: string | null;
  sampleRate: number | null;
  /** mpv sample format string (e.g. "s16", "s32", "floatp"). */
  format: string | null;
  /** Instantaneous bitrate in bits/s. */
  bitrate: number | null;
}

/** Install state of the downloadable libmpv component (Rust `ComponentStatus`). */
export interface EngineComponentStatus {
  /** A pinned artifact is published for this platform. */
  available: boolean;
  /** The managed copy is present in the engine dir. */
  installed: boolean;
  installedVersion: string | null;
  lockVersion: string | null;
  updateAvailable: boolean;
  /** Where the loader found libmpv: env | bundled | managed | vendored | system. */
  origin: string | null;
  /** libmpv is loaded in this process right now. */
  loaded: boolean;
  /** Approximate download size in MB, for the install button label. */
  sizeMb: number | null;
}

export interface EngineCapabilities {
  mpv: boolean;
  /** Native video rendering (macOS). */
  video: boolean;
  component: EngineComponentStatus | null;
}

let capabilityPromise: Promise<EngineCapabilities> | null = null;

/** This session's engine capabilities. Cached after the first probe. */
export function probeEngineCapabilities(): Promise<EngineCapabilities> {
  if (!capabilityPromise) {
    capabilityPromise = invoke<EngineCapabilities>("engine_capabilities")
      .then((caps) => ({ mpv: !!caps.mpv, video: !!caps.video, component: caps.component ?? null }))
      .catch((e) => {
        console.error("Failed to probe engine capabilities:", e);
        return { mpv: false, video: false, component: null };
      });
  }
  return capabilityPromise;
}

/** Drop the cached probe and re-ask the backend — call after installing or
 * removing the engine component (load failures aren't cached backend-side,
 * so a fresh install becomes usable immediately). */
export function refreshEngineCapabilities(): Promise<EngineCapabilities> {
  capabilityPromise = null;
  return probeEngineCapabilities();
}

/** Whether this build carries the mpv engine at all. */
export function probeEngineCapability(): Promise<boolean> {
  return probeEngineCapabilities().then((caps) => caps.mpv);
}

async function whenCapable(run: () => Promise<void>): Promise<void> {
  if (await probeEngineCapability()) await run();
}

export const nativeEngine = {
  /** Load + start a track. Caller must have verified capability (and video
   * capability when `video` is set). */
  play(args: {
    source: EngineSource;
    trackKey: string;
    seekSecs: number | null;
    volume: number;
    muted: boolean;
    video: boolean;
  }): Promise<void> {
    return invoke("engine_play", args);
  },
  /** Position the native video surface (top-left-origin points; caller
   * pre-multiplies its zoom factor). */
  setVideoBounds(x: number, y: number, width: number, height: number): Promise<void> {
    return whenCapable(() => invoke("engine_set_video_bounds", { x, y, width, height }));
  },
  /** Arm the next track. `crossfade` picks standby-deck arming (fade / hard
   * cut) over same-deck playlist arming (gapless). */
  preload(args: { source: EngineSource; trackKey: string; crossfade: boolean }): Promise<void> {
    return invoke("engine_preload", args);
  },
  /** Fade into the crossfade-armed track. Benign no-op when nothing is armed. */
  startCrossfade(secs: number): Promise<void> {
    return whenCapable(() => invoke("engine_start_crossfade", { secs }));
  },
  setEq(params: {
    enabled: boolean;
    mode: string;
    gains: number[];
    preGainDb: number;
    bassDb: number;
    trebleDb: number;
  }): Promise<void> {
    return whenCapable(() => invoke("engine_set_eq", { params }));
  },
  setReplayGain(params: { mode: string; preampDb: number; preventClip: boolean }): Promise<void> {
    return whenCapable(() => invoke("engine_set_replaygain", { params }));
  },
  clearPreload(): Promise<void> {
    return whenCapable(() => invoke("engine_clear_preload"));
  },
  setPaused(paused: boolean): Promise<void> {
    return whenCapable(() => invoke("engine_set_paused", { paused }));
  },
  stop(): Promise<void> {
    return whenCapable(() => invoke("engine_stop"));
  },
  seek(secs: number): Promise<void> {
    return whenCapable(() => invoke("engine_seek", { secs }));
  },
  setVolume(volume: number, muted: boolean): Promise<void> {
    return whenCapable(() => invoke("engine_set_volume", { volume, muted }));
  },
  /** Exclusive device access (bit-perfect). Applies from the next track;
   * the engine forces gapless-only arming while it's on. */
  setAudioExclusive(enabled: boolean): Promise<void> {
    return whenCapable(() => invoke("engine_set_audio_exclusive", { enabled }));
  },
  /** What the engine is decoding right now, or null (no native session /
   * incapable build). */
  getAudioInfo(): Promise<EngineAudioInfo | null> {
    return probeEngineCapabilities().then((caps) =>
      caps.mpv ? invoke<EngineAudioInfo | null>("engine_get_audio_info") : null,
    );
  },
};
