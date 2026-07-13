// Bit-perfect status for the native engine's exclusive-audio path.
//
// Exclusive device access bypasses the OS mixer, but the stream is only
// bit-perfect when the player itself also leaves the samples untouched: no
// EQ, no ReplayGain, and full volume (mpv's volume is softvol — digital
// attenuation applied before the samples reach the device).

export interface BitPerfectInputs {
  /** Exclusive audio access is enabled (Settings > Playback). */
  exclusive: boolean;
  eqEnabled: boolean;
  rgMode: "off" | "track" | "album";
  /** Player volume, 0..1. */
  volume: number;
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
  return blockers;
}

export function isBitPerfect(inputs: BitPerfectInputs): boolean {
  return bitPerfectBlockers(inputs).length === 0;
}
