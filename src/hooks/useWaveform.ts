import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

const MAX_BUCKETS = 400;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export function useWaveform(
  trackId: number | null,
  fileSize: number | null,
  subsonicId: string | null,
  isVideo: boolean,
  assetUrl: string | null,
): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPeaks(null);

    if (!trackId) return;
    if (subsonicId) return;
    if (isVideo) return;
    if (fileSize && fileSize > MAX_FILE_SIZE) return;

    let cancelled = false;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      // Check cache first
      try {
        const cached = await invoke<number[] | null>("get_cached_waveform", { trackId });
        if (cancelled) return;
        if (cached && cached.length > 0) {
          setPeaks(cached);
          return;
        }
      } catch {
        // Cache miss or read error — continue to analyze
      }

      if (!assetUrl) return;

      // Fetch + decode + compute peaks
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

        // Compute RMS per bucket (captures average energy, not just peak)
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

        // Normalize using 95th percentile (prevents loud sections from squashing the rest)
        const sorted = [...result].sort((a, b) => a - b);
        const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
        for (let i = 0; i < numBuckets; i++) {
          result[i] = Math.min(result[i] / p95, 1.0);
        }

        // Apply power curve to spread out lower values for better visual range
        for (let i = 0; i < numBuckets; i++) {
          result[i] = Math.pow(result[i], 0.6);
        }

        if (cancelled) return;
        setPeaks(result);

        // Cache for next time (fire-and-forget)
        invoke("cache_waveform", { trackId, peaks: result }).catch(() => {});
      } catch (e) {
        if (!cancelled) {
          console.debug("Waveform analysis failed:", e);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [trackId, fileSize, subsonicId, isVideo, assetUrl]);

  return peaks;
}
