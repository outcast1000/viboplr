// Playback failure message resolution.
//
// WKWebView reports a failed network fetch of a media source as
// MEDIA_ERR_SRC_NOT_SUPPORTED (code 4) or a NotSupportedError play() rejection —
// the same signals as a genuinely unsupported format. Without disambiguation, a
// dead internet connection surfaces as "File format not supported" for tracks
// that stream from the network. These helpers classify the network state so the
// error the user sees names the real problem.

export type NetworkStatus = "ok" | "offline" | "unreachable";

export const MEDIA_ERROR_MESSAGES: Record<number, string> = {
  1: "Playback aborted",
  2: "Network error during playback",
  3: "File could not be decoded — format may not be supported",
  4: "File format not supported",
};

export const OFFLINE_PLAYBACK_ERROR =
  "No internet connection — this track streams from the network";
export const UNREACHABLE_PLAYBACK_ERROR =
  "The streaming source could not be reached — check your connection";

export function mediaErrorMessage(code: number): string {
  return MEDIA_ERROR_MESSAGES[code] || `Playback error (code ${code})`;
}

// Pick the user-facing message for a playback failure. `base` is the browser's
// own diagnosis (media error code text or a play() rejection message); it is
// kept for local tracks and for remote tracks whose source host answered the
// probe (then the failure really is about the content, not the connection).
export function describePlaybackFailure(
  base: string,
  isRemote: boolean,
  network: NetworkStatus,
): string {
  if (!isRemote || network === "ok") return base;
  return network === "offline" ? OFFLINE_PLAYBACK_ERROR : UNREACHABLE_PLAYBACK_ERROR;
}

const PROBE_TIMEOUT_MS = 4000;

// Classify the network state for a failing http(s) source. `navigator.onLine ===
// false` is trusted as offline; otherwise the source URL is probed with a no-cors
// HEAD (media elements load cross-origin sources, but plain fetch is CORS-gated —
// no-cors resolves opaquely when the host is reachable and rejects on a
// network-level failure). Non-http sources (asset://, localhost transcode) never
// probe and report "ok".
export async function probeNetworkStatus(src: string | null): Promise<NetworkStatus> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  if (!src || !/^https?:\/\//i.test(src)) return "ok";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      await fetch(src, { method: "HEAD", mode: "no-cors", cache: "no-store", signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    return "ok";
  } catch (e) {
    console.error("Network probe failed for playback source:", e);
    return "unreachable";
  }
}
