// Typed bridge to the native mpv playback engine (`mpv-engine` full-build
// feature). Capability is probed once via `engine_capabilities` — present in
// every build — so the frontend gates on capability, not build flavor. All
// control methods silently no-op on incapable builds; only `play` requires the
// caller to have checked capability first (usePlayback gates on it).

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

export interface EngineCapabilities {
  mpv: boolean;
  /** Native video rendering (macOS full build). */
  video: boolean;
}

let capabilityPromise: Promise<EngineCapabilities> | null = null;

/** This build's engine capabilities. Cached after the first probe. */
export function probeEngineCapabilities(): Promise<EngineCapabilities> {
  if (!capabilityPromise) {
    capabilityPromise = invoke<EngineCapabilities>("engine_capabilities")
      .then((caps) => ({ mpv: !!caps.mpv, video: !!caps.video }))
      .catch((e) => {
        console.error("Failed to probe engine capabilities:", e);
        return { mpv: false, video: false };
      });
  }
  return capabilityPromise;
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
};
