import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

// Peaks are stored at a fixed one-bucket-per-second source resolution (width-
// independent), and WaveformSeekBar downsamples them to fit its render width —
// so one cached array serves both the now-playing bar and the fullscreen bar.

// Analysis reads the whole file into an ArrayBuffer and then decodes it to PCM,
// so peak memory is a large multiple of this — keep the ceiling conservative.
export const WAVEFORM_MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB

interface WaveformCache {
  name: string;
  duration: number;
  peaks: number[];
}

function waveformKey(artistName: string | null, title: string, durationSecs: number | null): string {
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
 * metadata alone (no I/O). Video is excluded because decoding a whole container
 * to PCM costs orders of magnitude more than an audio file for the same
 * duration. Remote streams (subsonic / plugin schemes / direct http) are
 * cross-origin to the webview, so the Web-Audio `fetch` is CORS-blocked and can
 * never produce peaks — they use the segmented seek bar by design. Only local
 * files (file:// → the fetchable asset protocol) are analyzable, so skip the
 * doomed fetch (and its console error) for everything else.
 */
export function isWaveformAnalyzable(
  candidate: WaveformCandidate,
): candidate is WaveformCandidate & { path: string; title: string } {
  if (!candidate.path || !candidate.title) return false;
  if (candidate.isVideo) return false;
  return candidate.path.startsWith("file://");
}

/**
 * Whether a file is small enough to decode in the webview. `null` means the
 * size couldn't be determined (file missing, or a path we can't stat) — treated
 * as too large, because the decode below reads the whole file into memory and
 * an unknown size is exactly the case we can't afford to guess wrong on.
 */
export function isWaveformSizeAllowed(fileSize: number | null): boolean {
  if (fileSize === null) return false;
  return fileSize <= WAVEFORM_MAX_FILE_SIZE;
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
          console.log(`[waveform] loaded cached: "${cached.name}" (${cached.duration}s, ${cached.peaks.length} buckets)`);
          setPeaks(cached.peaks);
          return;
        }
      } catch {
        // Cache miss or read error — continue to analyze
      }

      if (!assetUrl) return;

      // Size gate applies to analysis only, not display: an already-cached
      // waveform above the limit is free to render, so this sits after the cache
      // read. `path` is file:// here (isWaveformAnalyzable), so the stat resolves
      // to a real size unless the file has gone missing.
      let fileSize: number | null = null;
      try {
        fileSize = await invoke<number | null>("get_file_size", { path });
      } catch (e) {
        console.error("Failed to stat track for waveform size gate:", e);
      }
      if (cancelled) return;
      if (!isWaveformSizeAllowed(fileSize)) {
        console.log(`[waveform] skipped "${title}": size ${fileSize ?? "unknown"} not under the ${WAVEFORM_MAX_FILE_SIZE}-byte limit`);
        return;
      }

      try {
        const response = await fetch(assetUrl, { signal: controller.signal });
        if (cancelled) return;
        const arrayBuffer = await response.arrayBuffer();
        if (cancelled) return;

        const audioCtx = new OfflineAudioContext(1, 1, 44100);
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        if (cancelled) return;

        const channelData = audioBuffer.getChannelData(0);
        const totalSamples = channelData.length;
        const durationSecs = audioBuffer.duration;

        // One bucket per second (last bucket = leftover remainder). This fixed,
        // width-independent resolution is what WaveformSeekBar downsamples to fit.
        const samplesPerBucket = audioBuffer.sampleRate; // one second of samples
        const numBuckets = Math.max(1, Math.ceil(durationSecs));
        if (samplesPerBucket === 0) return;

        const result: number[] = new Array(numBuckets);
        for (let i = 0; i < numBuckets; i++) {
          const start = Math.floor(i * samplesPerBucket);
          const end = Math.min(Math.floor((i + 1) * samplesPerBucket), totalSamples);
          if (end <= start) {
            result[i] = 0;
            continue;
          }
          let sumSq = 0;
          for (let j = start; j < end; j++) {
            sumSq += channelData[j] * channelData[j];
          }
          result[i] = Math.sqrt(sumSq / (end - start));
        }

        let maxRms = 0;
        for (let i = 0; i < numBuckets; i++) {
          if (result[i] > maxRms) maxRms = result[i];
        }
        if (maxRms === 0) maxRms = 1;
        for (let i = 0; i < numBuckets; i++) {
          result[i] = Math.min(result[i] / maxRms, 1.0);
        }

        const MIN_HEIGHT = 0.03;
        for (let i = 0; i < numBuckets; i++) {
          result[i] = MIN_HEIGHT + (1 - MIN_HEIGHT) * Math.pow(result[i], 1.8);
        }

        if (cancelled) return;

        const name = title;
        const duration = trackDuration || Math.round(audioBuffer.duration);
        console.log(`[waveform] created new: "${name}" (${duration}s, ${result.length} buckets)`);
        setPeaks(result);

        const waveform: WaveformCache = { name, duration, peaks: result };
        invoke("cache_waveform", { key: cacheKey, waveform }).catch(() => {});
      } catch (e) {
        if (!cancelled) {
          console.log("Waveform analysis failed:", e);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [trackPath, trackName, trackArtist, trackDuration, isVideo, assetUrl]);

  return peaks;
}
