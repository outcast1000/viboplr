// The waveform provider contract. A provider turns one local audio file into RAW
// loudness — one RMS value per second, the last value covering the leftover
// remainder — and nothing else. Shaping (normalization + the display curve) is done
// once, by `shapePeaks`, for every provider, so a waveform looks the same whichever
// provider produced it and the cache never mixes two looks under one key.
//
// The app decides the order providers are tried in (`WAVEFORM_PROVIDERS` in
// providers.ts); a provider only says whether it could do this one.

export interface WaveformRequest {
  /** The track's `file://` path. Eligibility (local, audio) is checked before any provider runs. */
  path: string;
  title: string;
  /** Webview-fetchable URL for the same file (asset protocol), when one exists. */
  assetUrl: string | null;
  /** Aborted when the track changes; a provider stops its work and answers `cancelled`. */
  signal: AbortSignal;
}

export type WaveformAttempt =
  /** Raw per-second RMS (≥ 0, unnormalized). */
  | { status: "ok"; rms: number[] }
  /** This provider can't handle the request (tool missing, file too large…): try the next one. */
  | { status: "skipped"; reason: string }
  /** The request was aborted. Stops the whole chain. */
  | { status: "cancelled" };

export interface WaveformProvider {
  id: string;
  /** Throwing counts as a failure: it is logged and the next provider is tried. */
  analyze(request: WaveformRequest): Promise<WaveformAttempt>;
}
