// Playback failure message resolution.
//
// The mpv engine reports a failure as an `engine-error` carrying libmpv's own
// text ("loading failed", "unrecognized file format", …). Those name what the
// demuxer saw, not why: "loading failed" is as likely a dead connection or a
// file that was moved as a broken one. `engineErrorMessage` turns the engine's
// text into a sentence, and the describe* helpers then probe the real cause —
// the network for a remote track, the disk for a local one — so the error the
// user sees names the actual problem.

export type NetworkStatus = "ok" | "offline" | "unreachable";

export const OFFLINE_PLAYBACK_ERROR =
  "No internet connection — this track streams from the network";
export const UNREACHABLE_PLAYBACK_ERROR =
  "The streaming source could not be reached — check your connection";
export const FILE_NOT_FOUND_PLAYBACK_ERROR =
  "File not found — it may have been moved or deleted";
export const FORMAT_PLAYBACK_ERROR = "This file’s format can’t be played";
export const LOAD_PLAYBACK_ERROR = "The track couldn’t be opened";
export const AUDIO_OUTPUT_PLAYBACK_ERROR = "Couldn’t open the audio output device";
// libmpv could not be loaded on this machine, so nothing can play. Settings →
// Playback explains it and offers a replacement copy.
export const ENGINE_UNAVAILABLE_ERROR =
  "The playback engine couldn’t start on this machine — see Settings → Playback";
export const VIDEO_UNAVAILABLE_ERROR = "Video playback isn’t available on this system";
// A resolver answered with something that is neither a file nor an http(s) URL
// — the engine has no way to open it.
export const UNPLAYABLE_SOURCE_ERROR = "This track’s source can’t be played";

/** A user-facing sentence for the engine's own error text. */
export function engineErrorMessage(message: string | null | undefined): string {
  const text = (message ?? "").toLowerCase();
  if (text.includes("unrecognized file format") || text.includes("no audio or video data")) {
    return FORMAT_PLAYBACK_ERROR;
  }
  if (text.includes("audio output")) return AUDIO_OUTPUT_PLAYBACK_ERROR;
  if (text.includes("loading failed")) return LOAD_PLAYBACK_ERROR;
  return message?.trim() ? `Playback failed: ${message.trim()}` : "Playback failed";
}

// Format failures, as opposed to network or missing-file ones — the split the
// `playback_error` telemetry reports as `reason`. Keyed off the resolved
// message: network/missing-file causes resolve to their own messages first.
export function isFormatPlaybackError(error: string | null | undefined): boolean {
  return error === FORMAT_PLAYBACK_ERROR;
}

// Pick the user-facing message for a remote track's failure: the network probe
// outranks the engine's diagnosis, since a stream that can't be reached is
// reported as a load failure too.
export function describePlaybackFailure(
  base: string,
  isRemote: boolean,
  network: NetworkStatus,
): string {
  if (!isRemote) return base;
  if (network === "offline") return OFFLINE_PLAYBACK_ERROR;
  if (network === "unreachable") return UNREACHABLE_PLAYBACK_ERROR;
  return base;
}

// Local-track counterpart of describePlaybackFailure: `base` is kept while the
// file is still on disk (then the failure really is about the content); a
// missing file overrides it, since the engine reports it as a load failure.
export function describeLocalPlaybackFailure(base: string, fileExists: boolean): string {
  return fileExists ? base : FILE_NOT_FOUND_PLAYBACK_ERROR;
}

// ——— Failure surfacing: modal vs auto-skip ———
//
// A playback failure used to stop the music behind the error modal's 15s
// countdown no matter who started the track. The split now: a track the USER
// clicked keeps the modal (they acted and are watching — silence needs a reason
// on screen), while a track the QUEUE advanced to is skipped immediately, with
// a toast plus the queue row's persistent failure note carrying the information.

// Whose track a play attempt is FOR, as opposed to who issued the call.
export type PlayIntent = { key: string; source: "user" | "auto" };

// handlePlay's `source` alone can't answer "did the user ask for this track":
// the engine-error retry replays the SAME track as "auto" (deliberately, so
// it can't reset the quality ladder it just advanced), which would make a
// user-clicked track whose retries all fail look auto-initiated and get
// silently skipped. Rule: a "user" play always claims the intent; an "auto"
// play claims it only for a DIFFERENT track (a queue advance) — a same-key
// "auto" replay inherits the standing intent.
export function nextPlayIntent(
  prev: PlayIntent | null,
  trackKey: string,
  source: "user" | "auto",
): PlayIntent {
  if (source === "user" || prev?.key !== trackKey) return { key: trackKey, source };
  return prev;
}

// Circuit breaker: after this many consecutive auto-skipped failures the modal
// (with its slower 15s countdown) takes over. Without a cap, a fully dead queue
// in repeat-all would churn through the resolver chain forever. The streak
// resets on any explicit user play and whenever a track produces real playback
// progress.
export const MAX_CONSECUTIVE_AUTO_SKIPS = 3;

export function shouldAutoSkipFailure(
  intent: "user" | "auto",
  consecutiveAutoSkips: number,
): boolean {
  return intent === "auto" && consecutiveAutoSkips < MAX_CONSECUTIVE_AUTO_SKIPS;
}

const PROBE_TIMEOUT_MS = 4000;

// Classify the network state for a failing http(s) source. `navigator.onLine ===
// false` is trusted as offline; otherwise the source URL is probed with a no-cors
// HEAD (plain fetch is CORS-gated; no-cors resolves opaquely when the host is
// reachable and rejects on a network-level failure). Non-http sources never
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
