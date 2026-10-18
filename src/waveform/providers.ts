import { browserWaveformProvider } from "./browserProvider";
import { ffmpegWaveformProvider } from "./ffmpegProvider";
import { pluginWaveformProvider, type WaveformPluginBridge } from "./pluginProvider";
import type { WaveformProvider, WaveformRequest } from "./types";

/**
 * The computing providers, in the order they are tried — the app's decision, not
 * the user's. ffmpeg goes first: it streams (no size cap), decodes outside the
 * webview and mixes every channel. Web Audio is the fallback for machines without
 * ffmpeg.
 */
export const WAVEFORM_PROVIDERS: readonly WaveformProvider[] = [
  ffmpegWaveformProvider,
  browserWaveformProvider,
];

/**
 * The chain for one track: plugin lookups first (a waveform someone already
 * computed beats computing it again), then — for a local file only — the
 * computing providers. A stream gets the lookups alone: computing one would mean
 * downloading it a second time.
 */
export function waveformProviders(
  plugins: WaveformPluginBridge | null,
  { canCompute }: { canCompute: boolean },
): WaveformProvider[] {
  const lookups = plugins ? plugins.lookupProviderIds().map((id) => pluginWaveformProvider(id, plugins)) : [];
  return canCompute ? [...lookups, ...WAVEFORM_PROVIDERS] : lookups;
}

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
export function shapePeaks(rms: readonly number[]): number[];
/** Unheard seconds (`null`, a capture still building) stay `null`; the rest
 *  are shaped against the loudest second heard so far. */
export function shapePeaks(rms: readonly (number | null)[]): (number | null)[];
export function shapePeaks(rms: readonly (number | null)[]): (number | null)[] {
  let maxRms = 0;
  for (const v of rms) {
    if (v !== null && v > maxRms) maxRms = v;
  }
  if (maxRms === 0) maxRms = 1;
  return rms.map((v) => {
    if (v === null) return null;
    const n = Math.min(Math.max(v, 0) / maxRms, 1);
    return MIN_HEIGHT + (1 - MIN_HEIGHT) * Math.pow(n, CURVE);
  });
}
