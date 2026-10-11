import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { analyzeWaveform, shapePeaks, WAVEFORM_PROVIDERS } from "../waveform/providers";

// Peaks are stored at a fixed one-bucket-per-second source resolution (width-
// independent), and WaveformSeekBar downsamples them to fit its render width —
// so one cached array serves both the now-playing bar and the fullscreen bar.
//
// On a cache miss the analysis runs through the provider chain in
// src/waveform/providers.ts (ffmpeg first, Web Audio as the fallback); each
// provider returns raw per-second RMS and `shapePeaks` turns it into bar heights.

interface WaveformCache {
  name: string;
  duration: number;
  peaks: number[];
}

/**
 * Cache key for a track's peaks. Exported because `VisualizerSlot` reads the same
 * cache to texture a visualizer's grooves — duplicating this format there would
 * silently miss every entry the moment either copy changed.
 */
export function waveformKey(artistName: string | null, title: string, durationSecs: number | null): string {
  const artist = (artistName ?? "unknown").toLowerCase().trim();
  const t = title.toLowerCase().trim();
  const d = Math.round(durationSecs ?? 0);
  return `v3::${artist}::${t}::${d}`;
}

export interface WaveformCandidate {
  path: string | null;
  title: string | null;
  isVideo: boolean;
}

/**
 * Whether a track is a candidate for waveform analysis at all, judged from
 * metadata alone (no I/O). This gate applies to every provider; each provider
 * then applies its own limits (the Web Audio one also caps file size). Video is
 * excluded because it gets the filmstrip seek bar, and decoding a whole container
 * in the webview costs orders of magnitude more than an audio file. Remote streams
 * (subsonic / plugin schemes / direct http) are excluded by design — they use the
 * segmented seek bar, and analyzing one would mean downloading it a second time
 * (the Web Audio `fetch` is CORS-blocked for them anyway).
 */
export function isWaveformAnalyzable(
  candidate: WaveformCandidate,
): candidate is WaveformCandidate & { path: string; title: string } {
  if (!candidate.path || !candidate.title) return false;
  if (candidate.isVideo) return false;
  return candidate.path.startsWith("file://");
}

export function useWaveform(
  trackPath: string | null,
  trackName: string | null,
  trackArtist: string | null,
  trackDuration: number | null,
  isVideo: boolean,
  assetUrl: string | null,
): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPeaks(null);

    const candidate = { path: trackPath, title: trackName, isVideo };
    if (!isWaveformAnalyzable(candidate)) return;
    const { path, title } = candidate;

    const cacheKey = waveformKey(trackArtist, title, trackDuration);
    let cancelled = false;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      try {
        const cached = await invoke<WaveformCache | null>("get_cached_waveform", { key: cacheKey });
        if (cancelled) return;
        if (cached && cached.peaks && cached.peaks.length > 0) {
          console.debug(`[waveform] loaded cached: "${cached.name}" (${cached.duration}s, ${cached.peaks.length} buckets)`);
          setPeaks(cached.peaks);
          return;
        }
      } catch (e) {
        // A miss is `null`, not a throw; still worth analyzing after a read error.
        console.error("Failed to read cached waveform:", e);
      }

      const result = await analyzeWaveform(WAVEFORM_PROVIDERS, {
        path,
        title,
        assetUrl,
        signal: controller.signal,
      });
      if (cancelled || !result) return;

      const peaks = shapePeaks(result.rms);
      const duration = trackDuration || peaks.length;
      console.debug(`[waveform] created new via ${result.providerId}: "${title}" (${duration}s, ${peaks.length} buckets)`);
      setPeaks(peaks);

      const waveform: WaveformCache = { name: title, duration, peaks };
      // Fire-and-forget: the waveform is already rendered from memory; a failed
      // cache write only costs a recompute next time this track plays.
      invoke("cache_waveform", { key: cacheKey, waveform }).catch(() => {}); // eslint-disable-line no-restricted-syntax
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [trackPath, trackName, trackArtist, trackDuration, isVideo, assetUrl]);

  return peaks;
}
