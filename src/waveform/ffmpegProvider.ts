import { invoke } from "@tauri-apps/api/core";
import type { WaveformAttempt, WaveformProvider, WaveformRequest } from "./types";

interface WaveformAnalysis {
  status: "ok" | "unavailable" | "unsupported" | "cancelled";
  rms: number[] | null;
}

/**
 * ffmpeg in the backend (`src-tauri/src/waveform.rs`): streams 8 kHz mono PCM through
 * a pipe and sums it per second as it arrives, so memory stays flat at any file size
 * and nothing is decoded in the webview. Skips itself when ffmpeg isn't installed.
 */
export const ffmpegWaveformProvider: WaveformProvider = {
  id: "ffmpeg",
  async analyze({ path, signal }: WaveformRequest): Promise<WaveformAttempt> {
    if (signal.aborted) return { status: "cancelled" };
    const requestId = crypto.randomUUID();
    // The backend registers the request on a blocking thread, so this cancel can land
    // first — it remembers the id and the pass never starts.
    const onAbort = () => {
      invoke("cancel_waveform_analysis", { requestId }).catch((e) =>
        console.error("Failed to cancel ffmpeg waveform analysis:", e),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await invoke<WaveformAnalysis>("analyze_waveform_ffmpeg", { path, requestId });
      switch (result.status) {
        case "ok":
          return result.rms && result.rms.length > 0
            ? { status: "ok", rms: result.rms }
            : { status: "skipped", reason: "ffmpeg returned no audio" };
        case "cancelled":
          return { status: "cancelled" };
        case "unavailable":
          return { status: "skipped", reason: "ffmpeg is not installed" };
        default:
          return { status: "skipped", reason: "not a local file" };
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  },
};
