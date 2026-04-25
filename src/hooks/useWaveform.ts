import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

const MAX_BUCKETS = 400;
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB

interface WaveformCache {
  name: string;
  duration: number;
  peaks: number[];
}

function waveformKey(artistName: string | null, title: string, durationSecs: number | null): string {
  const artist = (artistName ?? "unknown").toLowerCase().trim();
  const t = title.toLowerCase().trim();
  const d = Math.round(durationSecs ?? 0);
  return `v2::${artist}::${t}::${d}`;
}

export function useWaveform(
  trackPath: string | null,
  trackName: string | null,
  trackArtist: string | null,
  trackDuration: number | null,
  fileSize: number | null,
  isVideo: boolean,
  assetUrl: string | null,
): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPeaks(null);

    if (!trackPath || !trackName) return;
    if (isVideo) return;
    if (fileSize && fileSize > MAX_FILE_SIZE) return;

    const cacheKey = waveformKey(trackArtist, trackName, trackDuration);
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

      try {
        const response = await fetch(assetUrl, { signal: controller.signal });
        if (cancelled) return;
        const arrayBuffer = await response.arrayBuffer();
        if (cancelled) return;

        const audioCtx = new OfflineAudioContext(1, 1, 44100);
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        if (cancelled) return;

        const channelData = audioBuffer.getChannelData(0);
        const numBuckets = Math.min(Math.ceil(audioBuffer.duration), MAX_BUCKETS);
        const bucketSize = Math.floor(channelData.length / numBuckets);
        if (bucketSize === 0) return;

        const result: number[] = new Array(numBuckets);
        for (let i = 0; i < numBuckets; i++) {
          let sumSq = 0;
          const start = i * bucketSize;
          const end = Math.min(start + bucketSize, channelData.length);
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

        const name = trackName;
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
  }, [trackPath, trackName, trackArtist, trackDuration, fileSize, isVideo, assetUrl]);

  return peaks;
}
