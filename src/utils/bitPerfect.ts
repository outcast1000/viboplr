// Bit-perfect status for the native engine's exclusive-audio path.
//
// Exclusive device access bypasses the OS mixer, but the stream is only
// bit-perfect when the player itself also leaves the samples untouched: no
// EQ, no ReplayGain, full volume (mpv's volume is softvol — digital
// attenuation applied before the samples reach the device) and speed 1 (with
// pitch correction off, any other speed resamples).
//
// Two consumers:
// - `bitPerfectBlockers` — the Settings > Playback exclusive row, describing
//   the user's *settings*.
// - `resolveBitPerfectState` — Bit-perfect mode, describing what the engine
//   *verified* (`engine-output`). The mode overlays neutral DSP engine-side, so
//   its verdict never depends on the settings, only on the device path.

export interface BitPerfectInputs {
  /** Exclusive audio access is enabled (Settings > Playback). */
  exclusive: boolean;
  eqEnabled: boolean;
  rgMode: "off" | "track" | "album";
  /** Player volume, 0..1. */
  volume: number;
  /** Playback rate; 1 = normal. Optional for callers that predate it. */
  speed?: number;
}

/** Volume is "full" within float tolerance. */
const FULL_VOLUME = 0.999;

/**
 * What stands between the current settings and a bit-perfect stream, in
 * display order. Empty array = bit-perfect (assuming `exclusive` is on —
 * without it the OS mixer is in the path regardless).
 */
export function bitPerfectBlockers(inputs: BitPerfectInputs): string[] {
  const blockers: string[] = [];
  if (!inputs.exclusive) blockers.push("exclusive off");
  if (inputs.eqEnabled) blockers.push("EQ");
  if (inputs.rgMode !== "off") blockers.push("ReplayGain");
  if (inputs.volume < FULL_VOLUME) {
    blockers.push(`volume ${Math.round(inputs.volume * 100)}%`);
  }
  if (inputs.speed !== undefined && Math.abs(inputs.speed - 1) > 1e-6) {
    blockers.push(`speed ${inputs.speed}x`);
  }
  return blockers;
}

export function isBitPerfect(inputs: BitPerfectInputs): boolean {
  return bitPerfectBlockers(inputs).length === 0;
}

// ── Bit-perfect mode ────────────────────────────────────────────────────────

/** Where Bit-perfect mode runs. The two differ in what they can observe
 *  (CoreAudio names the process holding a device; WASAPI names nobody) and
 *  in whether the OS volume keys still reach the held device. */
export type BitPerfectPlatform = "mac" | "windows";

/** The device Bit-perfect mode is pinned to (`engine_default_output_device`). */
export interface DevicePin {
  uid: string;
  name: string;
  /** The device exposes a settable hardware volume (Viboplr's volume control
   *  drives it while the mode is on). Informational; the engine ignores it. */
  hasVolume?: boolean;
}

/** `engine-output` — the engine's verified picture of the pinned device path. */
export interface EngineOutput {
  deviceUid: string;
  deviceName: string;
  devicePresent: boolean;
  /** This process holds the device exclusively (CoreAudio's hog-mode pid;
   *  on Windows, mpv's exclusive WASAPI output being open). */
  hoggedByUs: boolean;
  /** Another process holding the device, when not us (CoreAudio only). */
  holderPid: number | null;
  holderName: string | null;
  /** The device refused to open because another app holds it exclusively,
   *  holder unknown (WASAPI). The engine keeps the track and retries. */
  deviceBusy?: boolean;
  /** The engine's current track key, or null when it isn't playing anything. */
  trackKey: string | null;
  /** Decoded source rate / rate the output was opened at / device nominal rate. */
  srcRate: number | null;
  outRate: number | null;
  deviceRate: number | null;
  deviceMaxRate: number | null;
  /** Whether the device offers the source rate at all (null when unknown). */
  rateSupported: boolean | null;
  /** The device's own hardware volume (0..1), null when it has none. */
  deviceVolume: number | null;
}

export type BitPerfectState =
  /** On, but the engine hasn't reported yet (or is between tracks). */
  | { kind: "pending" }
  /** On, nothing playing — the device opens exclusively on the next play. */
  | { kind: "idle" }
  /** The current track is playing through the browser engine instead. */
  | { kind: "not-native" }
  /** Another app holds the device; playback resumes on release (mpv stalls
   *  silently on macOS, the engine retries on Windows). `canPlayShared`: turning
   *  the mode off plays through the shared mixer meanwhile — true on macOS, not
   *  on Windows, where an exclusive holder blocks shared playback too. */
  | { kind: "waiting"; holderName: string | null; canPlayShared: boolean }
  /** Playing, but exclusive access wasn't granted and nobody else holds it. */
  | { kind: "no-exclusive" }
  /** The device can't run at the source rate, so the stream is resampled. */
  | { kind: "device-limit"; maxRate: number | null }
  /** Some stage of the path isn't at the source rate. */
  | { kind: "resampled"; srcRate: number | null; outRate: number | null; deviceRate: number | null }
  | { kind: "bit-perfect"; rate: number }
  /** The pinned device disappeared (unplugged). The mode turns itself off. */
  | { kind: "gone" };

export interface BitPerfectContext {
  playing: boolean;
  /** Key of the track the frontend considers current. */
  currentKey: string | null;
  /** Inside the grace window after the output (re)opened — see
   *  `isOutputSettling`. Transient mismatches read as `pending` meanwhile. */
  settling?: boolean;
}

/** How long a reopening output may look wrong before it's reported. Measured:
 *  exclusive access and the device's rate switch each land ~1s after the AO
 *  opens, so every enable and every rate change flashed amber for a second. */
export const BIT_PERFECT_SETTLE_MS = 2000;

/**
 * A report that looks like an output still (re)opening: exclusive access not
 * granted yet with nobody else holding the device, or a stage not yet at the
 * source rate. The same shapes are real failures when they persist, which is
 * why they get a grace window rather than being ignored. A busy device
 * (`holderPid`) and a device that can't reach the rate are never transient.
 */
export function isOutputSettling(output: EngineOutput): boolean {
  if (!output.devicePresent || output.trackKey === null) return false;
  if (!output.hoggedByUs) return output.holderPid === null && !output.deviceBusy;
  if (output.rateSupported === false) return false;
  if (output.srcRate === null || output.outRate === null) return false;
  return output.outRate !== output.srcRate || (output.deviceRate !== null && output.deviceRate !== output.outRate);
}

/**
 * Fold an `engine-output` report into one state. Only positive, verified
 * evidence yields `bit-perfect`: exclusive access held by us, and the source,
 * output and device all at the same rate.
 */
export function resolveBitPerfectState(
  output: EngineOutput | null,
  ctx: BitPerfectContext,
): BitPerfectState {
  if (!output) return { kind: "pending" };
  if (!output.devicePresent) return { kind: "gone" };
  if (output.trackKey === null) {
    // The engine isn't playing. While the app is, the track went elsewhere
    // (browser-engine fallback, which stops the engine first).
    return ctx.playing && ctx.currentKey !== null ? { kind: "not-native" } : { kind: "idle" };
  }
  // A report about a different track is stale (the watchdog polls) — or the
  // engine is still on the outgoing track. Neither is a verdict.
  if (ctx.currentKey !== null && output.trackKey !== ctx.currentKey) return { kind: "pending" };
  if (!output.hoggedByUs) {
    if (output.holderPid !== null) return { kind: "waiting", holderName: output.holderName, canPlayShared: true };
    if (output.deviceBusy) return { kind: "waiting", holderName: null, canPlayShared: false };
    // Paused with the output closed is not a failure — it reopens on play.
    if (!ctx.playing) return { kind: "idle" };
    return ctx.settling ? { kind: "pending" } : { kind: "no-exclusive" };
  }
  if (output.srcRate === null || output.outRate === null) return { kind: "pending" };
  if (output.rateSupported === false) return { kind: "device-limit", maxRate: output.deviceMaxRate };
  if (output.outRate !== output.srcRate || (output.deviceRate !== null && output.deviceRate !== output.outRate)) {
    if (ctx.settling) return { kind: "pending" };
    return { kind: "resampled", srcRate: output.srcRate, outRate: output.outRate, deviceRate: output.deviceRate };
  }
  return { kind: "bit-perfect", rate: output.srcRate };
}

/** 44100 → "44.1 kHz", 96000 → "96 kHz". */
export function formatSampleRate(hz: number | null): string {
  if (hz === null || !Number.isFinite(hz) || hz <= 0) return "?";
  const khz = hz / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

export type BitPerfectTone = "ok" | "warn" | "neutral";

/** Badge tone + tooltip for a state. `deviceName` is the pinned device's. */
export function describeBitPerfectState(
  state: BitPerfectState,
  deviceName: string,
): { tone: BitPerfectTone; text: string } {
  switch (state.kind) {
    case "bit-perfect":
      return { tone: "ok", text: `Bit-perfect · ${formatSampleRate(state.rate)} · ${deviceName}` };
    case "pending":
      return { tone: "neutral", text: `Bit-perfect on ${deviceName} · checking…` };
    case "idle":
      return { tone: "neutral", text: `Bit-perfect on ${deviceName} · ready` };
    case "not-native":
      return { tone: "warn", text: "Not bit-perfect: this track is playing through the browser engine" };
    case "waiting":
      return {
        tone: "warn",
        text: state.canPlayShared
          ? `Waiting for ${deviceName} — in use by ${state.holderName ?? "another app"}. Playback resumes when it's free; click to play shared instead.`
          : `Waiting for ${deviceName} — another app is using it exclusively. Playback resumes when it's free.`,
      };
    case "no-exclusive":
      return { tone: "warn", text: `Not bit-perfect: exclusive access to ${deviceName} wasn't granted` };
    case "device-limit":
      return {
        tone: "warn",
        text: state.maxRate
          ? `${deviceName} supports up to ${formatSampleRate(state.maxRate)} — this track is resampled`
          : `${deviceName} can't play this sample rate — this track is resampled`,
      };
    case "resampled":
      return {
        tone: "warn",
        text: `Not bit-perfect: ${formatSampleRate(state.srcRate)} source, device at ${formatSampleRate(state.deviceRate ?? state.outRate)}`,
      };
    case "gone":
      return { tone: "warn", text: `${deviceName} disconnected` };
  }
}

/** Tooltips for the controls Bit-perfect mode overrides. */
export const BIT_PERFECT_EQ_REASON = "Equalizer suspended by Bit-perfect mode";
/** Volume while on, for a device with no controllable volume of its own. */
export const BIT_PERFECT_VOLUME_REASON = "This device has no volume control — in Bit-perfect mode, set the level on your DAC or amplifier";

/** Volume tooltip while on, for a device whose own volume Viboplr controls. */
export function bitPerfectDeviceVolumeNote(deviceName: string, platform: BitPerfectPlatform): string {
  return `Volume of ${deviceName} — Bit-perfect mode sets the device's own level, so the audio stays untouched. ` +
    volumeKeysNote(platform, true);
}

/**
 * What the OS volume keys do while the device is held. macOS moves its system
 * output off a hogged device, so the keys go elsewhere. Windows leaves the
 * default where it is, and on a device with hardware volume the keys drive the
 * same endpoint level Viboplr does; without one, the endpoint level is a
 * software gain that exclusive mode bypasses, so the keys do nothing.
 */
export function volumeKeysNote(platform: BitPerfectPlatform, hasVolume: boolean): string {
  if (platform === "mac") return "Your Mac's volume keys can't reach it while Viboplr holds it; use this slider.";
  return hasVolume
    ? "The Windows volume keys adjust it too."
    : "The Windows volume keys won't change it either.";
}

/**
 * Device volume to set at enable time so loudness doesn't jump: the mode takes
 * the player to full digital scale, so the device comes down by the player's
 * old level instead. The scalar is roughly perceptual, so multiplying errs
 * quieter, never louder. Null when there's nothing to lower.
 */
export function handoverDeviceVolume(deviceVolume: number | null, appVolume: number): number | null {
  if (deviceVolume === null || !(appVolume < 0.999)) return null;
  return Math.max(0, Math.min(1, deviceVolume * Math.max(0, appVolume)));
}
