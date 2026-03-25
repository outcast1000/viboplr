import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

const NUM_BUCKETS = 200;
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
        const bucketSize = Math.floor(channelData.length / NUM_BUCKETS);
        if (bucketSize === 0) return;

        const result: number[] = new Array(NUM_BUCKETS);
        let maxPeak = 0;
        for (let i = 0; i < NUM_BUCKETS; i++) {
          let max = 0;
          const start = i * bucketSize;
          const end = Math.min(start + bucketSize, channelData.length);
          for (let j = start; j < end; j++) {
            const abs = Math.abs(channelData[j]);
            if (abs > max) max = abs;
          }
          result[i] = max;
          if (max > maxPeak) maxPeak = max;
        }

        // Normalize to 0..1
        if (maxPeak > 0) {
          for (let i = 0; i < NUM_BUCKETS; i++) {
            result[i] /= maxPeak;
          }
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
