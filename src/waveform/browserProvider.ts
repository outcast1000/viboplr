import { invoke } from "@tauri-apps/api/core";
import type { WaveformAttempt, WaveformProvider, WaveformRequest } from "./types";

// This provider reads the whole file into an ArrayBuffer and then decodes all of it
// to PCM, so peak memory is a large multiple of this — keep the ceiling conservative.
// The ffmpeg provider streams and has no such limit.
export const WAVEFORM_MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB

/**
 * Whether a file is small enough to decode in the webview. `null` means the size
 * couldn't be determined (file missing, or a path we can't stat) — treated as too
 * large, because the decode reads the whole file into memory and an unknown size is
 * exactly the case we can't afford to guess wrong on.
 */
export function isWaveformSizeAllowed(fileSize: number | null): boolean {
  if (fileSize === null) return false;
  return fileSize <= WAVEFORM_MAX_FILE_SIZE;
}

/**
 * Web Audio in the webview: fetch the file through the asset protocol and decode it
 * with `OfflineAudioContext`. Needs no external tool, so it is the fallback that
 * always exists — limited to files under `WAVEFORM_MAX_FILE_SIZE`, channel 0 only.
 */
export const browserWaveformProvider: WaveformProvider = {
  id: "browser",
  async analyze({ path, title, assetUrl, signal }: WaveformRequest): Promise<WaveformAttempt> {
    if (!assetUrl) return { status: "skipped", reason: "no fetchable URL" };

    let fileSize: number | null = null;
    try {
      fileSize = await invoke<number | null>("get_file_size", { path });
    } catch (e) {
      console.error("Failed to stat track for waveform size gate:", e);
    }
    if (signal.aborted) return { status: "cancelled" };
    if (!isWaveformSizeAllowed(fileSize)) {
      return {
        status: "skipped",
        reason: `"${title}" size ${fileSize ?? "unknown"} not under the ${WAVEFORM_MAX_FILE_SIZE}-byte limit`,
      };
    }

    let arrayBuffer: ArrayBuffer;
    try {
      const response = await fetch(assetUrl, { signal });
      arrayBuffer = await response.arrayBuffer();
    } catch (e) {
      if (signal.aborted) return { status: "cancelled" };
      throw e;
    }
    if (signal.aborted) return { status: "cancelled" };

    const audioCtx = new OfflineAudioContext(1, 1, 44100);
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    if (signal.aborted) return { status: "cancelled" };

    const channelData = audioBuffer.getChannelData(0);
    const totalSamples = channelData.length;
    // One bucket per second (last bucket = leftover remainder).
    const samplesPerBucket = audioBuffer.sampleRate;
    if (samplesPerBucket === 0) return { status: "skipped", reason: "decoded audio has no sample rate" };
    const numBuckets = Math.max(1, Math.ceil(audioBuffer.duration));

    const rms: number[] = new Array(numBuckets);
    for (let i = 0; i < numBuckets; i++) {
      const start = Math.floor(i * samplesPerBucket);
      const end = Math.min(Math.floor((i + 1) * samplesPerBucket), totalSamples);
      if (end <= start) {
        rms[i] = 0;
        continue;
      }
      let sumSq = 0;
      for (let j = start; j < end; j++) {
        sumSq += channelData[j] * channelData[j];
      }
      rms[i] = Math.sqrt(sumSq / (end - start));
    }
    return { status: "ok", rms };
  },
};
