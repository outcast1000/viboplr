// Picks which of a resolver's stream candidates to play, per the active
// playback engine's capabilities. This is the "engine decides" half of the
// candidate-list stream contract (see src/types/plugin.ts `StreamCandidate`):
// the plugin enumerates what a source offers; the host selects here.
//
// The native mpv engine can attach a separate audio stream to a video-only
// stream (`audio-file`), so it prefers a hi-res video-only + audio-only pair.
// The browser <video>/<audio> element can't merge two streams, so it needs a
// self-contained (muxed) stream. `browserUrl` is always a self-contained URL,
// used as the element `src` AND as the safe fallback when a native play errors
// (usePlayback re-uses the resolved source without re-resolving).
//
// Pure and unit-tested — no host/plugin imports beyond the shared type.
import type { StreamCandidate } from "../types/plugin";

export interface SelectStreamContext {
  /** Active playback engine. `native` = mpv (can merge external audio). */
  engine: "native" | "browser";
  /** Whether the track is being played as video. */
  video: boolean;
}

export interface SelectedStream {
  /** Primary stream URL. For a native video pick this is video-only and must be
   *  paired with `audioUrl`; otherwise it is self-contained. */
  url: string;
  /** Companion audio stream for a native video pick (mpv attaches it). */
  audioUrl?: string;
  /** Headers for the native source URL, when its provider requires them. */
  headers?: Record<string, string>;
  /** A self-contained URL safe for the browser element / native-error fallback. */
  browserUrl: string;
  /** Whether the selected stream carries video. */
  video: boolean;
}

const isVideoKind = (c: StreamCandidate) => c.kind === "video" || c.kind === "muxed";
const isAudioKind = (c: StreamCandidate) => c.kind === "audio" || c.kind === "muxed";

// Browser-safe = universally decodable by both WKWebView and WebView2: mp4/avc
// video, m4a/aac audio. webm/vp9/opus play on WebView2 but not WKWebView, so we
// never pick them as the browser-safe stream.
const browserSafeVideo = (c: StreamCandidate) =>
  (c.container === "mp4" || (c.vcodec ?? "").startsWith("avc")) &&
  (c.kind === "video" || (c.acodec ?? "").startsWith("mp4a") || (c.acodec ?? "").startsWith("aac"));
const browserSafeAudio = (c: StreamCandidate) =>
  c.container === "m4a" || (c.acodec ?? "").startsWith("mp4a") || (c.acodec ?? "").startsWith("aac");

// Higher is better: resolution first, then bitrate. Stable across equal keys.
function byQualityDesc(a: StreamCandidate, b: StreamCandidate): number {
  const dh = (b.height ?? 0) - (a.height ?? 0);
  if (dh !== 0) return dh;
  return (b.tbr ?? 0) - (a.tbr ?? 0);
}

// Prefer browser-safe first (mp4/avc, m4a/aac), then quality — so the muxed /
// browser stream is always element-playable when such a stream exists.
function pickBest(
  candidates: StreamCandidate[],
  eligible: (c: StreamCandidate) => boolean,
  preferSafe: (c: StreamCandidate) => boolean,
): StreamCandidate | null {
  const pool = candidates.filter(eligible);
  if (pool.length === 0) return null;
  const safe = pool.filter(preferSafe).sort(byQualityDesc);
  if (safe.length) return safe[0];
  return pool.slice().sort(byQualityDesc)[0];
}

/**
 * Choose the stream(s) to play from a resolver's candidate list.
 * Returns null when no candidate can satisfy the request.
 */
export function selectStream(
  candidates: StreamCandidate[],
  ctx: SelectStreamContext,
): SelectedStream | null {
  if (!candidates || candidates.length === 0) return null;

  if (ctx.video) {
    // Best self-contained video stream (muxed) — the browser src + native-error
    // fallback. Prefer a browser-safe muxed stream; else any muxed.
    const muxed =
      pickBest(candidates, (c) => c.kind === "muxed", browserSafeVideo) ??
      // No muxed at all → some sources expose a single self-contained HLS/DASH
      // manifest tagged `muxed`; already covered above. As a last resort use the
      // best video candidate so the browser at least shows a picture.
      pickBest(candidates, isVideoKind, browserSafeVideo);
    if (ctx.engine === "native") {
      const videoOnly = pickBest(candidates, (c) => c.kind === "video", browserSafeVideo);
      const audioOnly = pickBest(candidates, (c) => c.kind === "audio", browserSafeAudio);
      if (videoOnly && audioOnly) {
        return {
          url: videoOnly.url,
          audioUrl: audioOnly.url,
          headers: videoOnly.headers,
          browserUrl: muxed?.url ?? videoOnly.url,
          video: true,
        };
      }
      // No usable split pair — fall back to the muxed stream for mpv too.
    }
    if (muxed) return { url: muxed.url, headers: muxed.headers, browserUrl: muxed.url, video: true };
    return null;
  }

  // Audio: the native engine can play opus/webm; the browser element wants
  // m4a/aac. Prefer a pure audio-only stream (a muxed stream would pull video
  // bytes we don't need) and only fall back to muxed when no audio-only exists.
  // `browserUrl` is always a browser-safe audio stream when one exists.
  const bestAudio =
    pickBest(candidates, (c) => c.kind === "audio", browserSafeAudio) ??
    pickBest(candidates, isAudioKind, browserSafeAudio);
  if (!bestAudio) return null;
  return { url: bestAudio.url, headers: bestAudio.headers, browserUrl: bestAudio.url, video: false };
}
