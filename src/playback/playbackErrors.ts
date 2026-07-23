// Playback failure message resolution.
//
// WKWebView reports a failed fetch of a media source as
// MEDIA_ERR_SRC_NOT_SUPPORTED (code 4) or a NotSupportedError play() rejection —
// the same signals as a genuinely unsupported format. Without disambiguation, a
// dead internet connection (remote tracks) or a deleted/moved file (local
// tracks) surfaces as "File format not supported". These helpers classify the
// real cause so the error the user sees names the real problem.

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
export const FILE_NOT_FOUND_PLAYBACK_ERROR =
  "File not found — it may have been moved or deleted";
export const VIDEO_CODEC_PLAYBACK_ERROR = "Video codec not supported";
// A reachable REMOTE source that still failed as a format/codec error: the
// built-in player can't decode this stream (e.g. VP9/Opus from the web), but the
// mpv engine usually can. Worded for a stream (not a local file) — and kept in
// FORMAT_PLAYBACK_ERRORS below so the "use mpv" offer still appears.
export const REMOTE_FORMAT_PLAYBACK_ERROR =
  "This stream can’t be played by the built-in player";

export function mediaErrorMessage(code: number): string {
  return MEDIA_ERROR_MESSAGES[code] || `Playback error (code ${code})`;
}

// Format/codec failures — as opposed to network or missing-file failures — are
// the ones the native mpv engine can often play where WKWebView can't, so the
// app offers "install the mpv engine and retry" on these. Keyed off the
// resolved user-facing message: it only lands on one of these strings when the
// cause really is the content, because network/missing-file cases resolve to
// their own messages first (see describe*PlaybackFailure).
const FORMAT_PLAYBACK_ERRORS = new Set<string>([
  MEDIA_ERROR_MESSAGES[3],
  MEDIA_ERROR_MESSAGES[4],
  VIDEO_CODEC_PLAYBACK_ERROR,
  REMOTE_FORMAT_PLAYBACK_ERROR,
]);

export function isFormatPlaybackError(error: string | null | undefined): boolean {
  return !!error && FORMAT_PLAYBACK_ERRORS.has(error);
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
  if (!isRemote) return base;
  if (network === "offline") return OFFLINE_PLAYBACK_ERROR;
  if (network === "unreachable") return UNREACHABLE_PLAYBACK_ERROR;
  // Reachable, but a format/codec failure on a remote stream: name it as a
  // stream the built-in player can't play (the mpv engine can). Non-format
  // failures keep the browser's own diagnosis.
  if (isFormatPlaybackError(base)) return REMOTE_FORMAT_PLAYBACK_ERROR;
  return base;
}

// Local-track counterpart of describePlaybackFailure: `base` is kept while the
// file is still on disk (then the failure really is about the content); a
// missing file overrides it, since the browser reported the failed asset://
// fetch as a format error.
export function describeLocalPlaybackFailure(base: string, fileExists: boolean): string {
  return fileExists ? base : FILE_NOT_FOUND_PLAYBACK_ERROR;
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
