// The waveform the playback engine records while it plays a track
// (`src-tauri/src/mpv_engine/wave_capture.rs`). It is how a stream — which the
// computing providers never touch, since that would download it twice — gets a
// waveform of its own: the engine reads the loudness of the samples it is
// already decoding. It builds up as the track is heard, so until the whole of
// it has been the seek bar shows what is known and leaves the rest as unheard.

import { invoke } from "@tauri-apps/api/core";

/** What `engine_wave_capture` answers: one raw RMS per second (`null` where
 *  nothing was heard yet) and the fraction of the track's length heard. */
export interface EngineWaveCapture {
  rms: (number | null)[];
  coverage: number;
  durationSecs: number | null;
}

/** Heard this much of the track and the capture counts as the track's
 *  waveform: cached and shared. Below it, it is only drawn. The 1% allowance
 *  covers the last few milliseconds the engine can't read before a file
 *  closes, and a skip over a second or two of a long track. */
export const CAPTURE_COMPLETE_COVERAGE = 0.99;

/** How often the seek bar asks the engine for more while a capture builds. */
export const CAPTURE_POLL_MS = 2000;

/** Provider id of a capture's result. Not a plugin id, so it gets shared. */
export const ENGINE_CAPTURE_PROVIDER_ID = "engine-capture";

export async function readEngineCapture(trackKey: string): Promise<EngineWaveCapture | null> {
  return invoke<EngineWaveCapture | null>("engine_wave_capture", { trackKey });
}

export function isCaptureComplete(capture: EngineWaveCapture): boolean {
  return capture.coverage >= CAPTURE_COMPLETE_COVERAGE && capture.rms.some((v) => v !== null);
}

/**
 * A complete capture's RMS with its few unheard seconds filled in from their
 * neighbours (linear between the nearest heard seconds, held flat at either
 * end), so it can be cached and shared like any computed waveform.
 */
export function fillCaptureGaps(rms: readonly (number | null)[]): number[] {
  const out = new Array<number>(rms.length);
  let prev = -1;
  for (let i = 0; i < rms.length; i++) {
    const v = rms[i];
    if (v === null) continue;
    const from = prev >= 0 ? (rms[prev] as number) : v;
    for (let j = prev + 1; j < i; j++) {
      out[j] = from + ((v - from) * (j - prev)) / (i - prev);
    }
    out[i] = v;
    prev = i;
  }
  const last = prev >= 0 ? (rms[prev] as number) : 0;
  for (let j = prev + 1; j < rms.length; j++) out[j] = last;
  return out;
}
