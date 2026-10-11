import { browserWaveformProvider } from "./browserProvider";
import { ffmpegWaveformProvider } from "./ffmpegProvider";
import type { WaveformProvider, WaveformRequest } from "./types";

/**
 * The order providers are tried in — the app's decision, not the user's. ffmpeg goes
 * first: it streams (no size cap), decodes outside the webview and mixes every
 * channel. Web Audio is the fallback for machines without ffmpeg.
 */
export const WAVEFORM_PROVIDERS: readonly WaveformProvider[] = [
  ffmpegWaveformProvider,
  browserWaveformProvider,
];

export interface WaveformAnalysisResult {
  providerId: string;
  rms: number[];
}

/**
 * Try each provider in order until one produces RMS. A `skipped` answer or a throw
 * moves on to the next provider; `cancelled` (or an aborted signal) stops the chain.
 * Resolves `null` when nothing produced a waveform.
 */
export async function analyzeWaveform(
  providers: readonly WaveformProvider[],
  request: WaveformRequest,
): Promise<WaveformAnalysisResult | null> {
  for (const provider of providers) {
    if (request.signal.aborted) return null;
    try {
      const attempt = await provider.analyze(request);
      if (attempt.status === "ok") return { providerId: provider.id, rms: attempt.rms };
      if (attempt.status === "cancelled") return null;
      console.debug(`[waveform] ${provider.id} skipped "${request.title}": ${attempt.reason}`);
    } catch (e) {
      if (request.signal.aborted) return null;
      console.error(`Waveform analysis via ${provider.id} failed:`, e);
    }
  }
  return null;
}

/** Bars never drop below this, so silent passages still read as a thin line. */
const MIN_HEIGHT = 0.03;
/** >1 widens the gap between loud and quiet passages. */
const CURVE = 1.8;

/**
 * Raw RMS → bar heights in [MIN_HEIGHT, 1]: divide by the loudest bucket, then apply
 * the display curve. Shared by every provider (see types.ts). Changing it changes the
 * look of cached waveforms too — bump the `waveformKey` prefix when it does.
 */
export function shapePeaks(rms: readonly number[]): number[] {
  let maxRms = 0;
  for (const v of rms) {
    if (v > maxRms) maxRms = v;
  }
  if (maxRms === 0) maxRms = 1;
  return rms.map((v) => {
    const n = Math.min(Math.max(v, 0) / maxRms, 1);
    return MIN_HEIGHT + (1 - MIN_HEIGHT) * Math.pow(n, CURVE);
  });
}
