// The waveform provider contract. A provider turns one local audio file into RAW
// loudness — one RMS value per second, the last value covering the leftover
// remainder — and nothing else. Shaping (normalization + the display curve) is done
// once, by `shapePeaks`, for every provider, so a waveform looks the same whichever
// provider produced it and the cache never mixes two looks under one key.
//
// The app decides the order providers are tried in (`waveformProviders` in
// providers.ts); a provider only says whether it could do this one. Plugin
// providers (`api.waveforms.onLookup`, e.g. Viboplr Community) come first and
// *fetch* a waveform someone already computed, so they also serve streams; the
// computing providers run only for local files.

/** What a plugin waveform provider is told about the track: enough to find the
 *  same recording elsewhere (metadata + duration) and to describe the copy
 *  (codec, sample rate, bit depth…). Never a path or a file size. */
export interface TrackAudioFacts {
  title: string;
  artistName: string | null;
  albumName: string | null;
  albumArtistName: string | null;
  durationSecs: number;
  codec: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  bitrateKbps: number | null;
}

export interface WaveformRequest {
  /** The track's path. The computing providers only ever see a `file://` one —
   *  the chain leaves them out for anything else. */
  path: string;
  title: string;
  /** Webview-fetchable URL for the same file (asset protocol), when one exists. */
  assetUrl: string | null;
  /** Aborted when the track changes; a provider stops its work and answers `cancelled`. */
  signal: AbortSignal;
  /** The track's audio facts, resolved on first call and shared by every provider
   *  that asks. Only plugin providers need them; null when they can't be had. */
  facts: () => Promise<TrackAudioFacts | null>;
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
