// Picks which of a resolver's stream candidates to play. This is the "host
// decides" half of the candidate-list stream contract (see src/types/plugin.ts
// `StreamCandidate`): the plugin enumerates what a source offers; the host
// selects here.
//
// The mpv engine can attach a separate audio stream to a video-only stream
// (`audio-file`), so for video it prefers a hi-res video-only + audio-only pair
// and falls back to a self-contained (muxed) stream when no pair exists.
//
// Pure and unit-tested — no host/plugin imports beyond the shared type.
import type { StreamCandidate } from "../types/plugin";

export interface SelectStreamContext {
  /** Whether the track is being played as video. */
  video: boolean;
  /** How many of the preferred video streams to step past. Driven by
   *  `playbackRetry.streamLadderStep`, which holds it at 0 for ordinary retries
   *  — a refusal is not a property of the rung, so descending would trade
   *  resolution away for nothing — and raises it only for a track's last
   *  attempt. */
  skipTopVideo?: number;
}

export interface SelectedStream {
  /** Primary stream URL. For a split video pick this is video-only and must be
   *  paired with `audioUrl`; otherwise it is self-contained. */
  url: string;
  /** Companion audio stream for a split video pick (mpv attaches it). */
  audioUrl?: string;
  /** Headers for the source URL, when its provider requires them. */
  headers?: Record<string, string>;
  /** Whether the selected stream carries video. */
  video: boolean;
}

const isVideoKind = (c: StreamCandidate) => c.kind === "video" || c.kind === "muxed";
const isAudioKind = (c: StreamCandidate) => c.kind === "audio" || c.kind === "muxed";

// avc video in mp4. Video picks take it over any quality the other codecs
// offer — not for compatibility (mpv decodes all of them) but for cost: avc is
// hardware-decoded everywhere, while AV1 is hardware-decoded only on recent
// chips (Apple M3+), so a 1440p/4K VP9/AV1 pick can mean a software decode
// eating CPU and battery for a video in a window, on a heavier stream.
const commonVideo = (c: StreamCandidate) =>
  (c.container === "mp4" || (c.vcodec ?? "").startsWith("avc")) &&
  (c.kind === "video" || (c.acodec ?? "").startsWith("mp4a") || (c.acodec ?? "").startsWith("aac"));
// m4a/aac audio. Only a tiebreak: audio is cheap to decode in any codec, so
// quality decides first (opus at 160k beats m4a at 128k).
const commonAudio = (c: StreamCandidate) =>
  c.container === "m4a" || (c.acodec ?? "").startsWith("mp4a") || (c.acodec ?? "").startsWith("aac");

// Higher is better: resolution first, then bitrate. Stable across equal keys.
function byQualityDesc(a: StreamCandidate, b: StreamCandidate): number {
  const dh = (b.height ?? 0) - (a.height ?? 0);
  if (dh !== 0) return dh;
  return (b.tbr ?? 0) - (a.tbr ?? 0);
}

// Prefer the given encodings first, then quality. `skip` steps down that same
// order, for retrying after a stream failed to open.
function pickBest(
  candidates: StreamCandidate[],
  eligible: (c: StreamCandidate) => boolean,
  prefer: (c: StreamCandidate) => boolean,
  skip = 0,
): StreamCandidate | null {
  const pool = candidates.filter(eligible);
  if (pool.length === 0) return null;
  const preferred = pool.filter(prefer).sort(byQualityDesc);
  if (skip <= 0) return preferred.length ? preferred[0] : pool.slice().sort(byQualityDesc)[0];
  // Ranked preference order, preferred first then the rest, so a ladder that
  // runs past the end of the preferred streams keeps descending instead of
  // stopping.
  const rest = pool.filter((c) => !preferred.includes(c)).sort(byQualityDesc);
  const ordered = [...preferred, ...rest];
  return skip < ordered.length ? ordered[skip] : null;
}

// Quality first, `prefer` only between equal-quality candidates.
function pickByQuality(
  candidates: StreamCandidate[],
  eligible: (c: StreamCandidate) => boolean,
  prefer: (c: StreamCandidate) => boolean,
): StreamCandidate | null {
  const pool = candidates.filter(eligible);
  if (pool.length === 0) return null;
  return pool.slice().sort((a, b) => byQualityDesc(a, b) || Number(prefer(b)) - Number(prefer(a)))[0];
}

/**
 * Does this selected candidate still need classifying as a URL, rather than
 * being turned straight into an http `EngineSource`?
 *
 * A candidate is only a URL, and not every plugin scheme resolves to the
 * network: one may name a file already on this disk (the qBittorrent plugin's
 * `qbt://` resolves to the downloaded file). Handing that to the engine as
 * `{ kind: "http" }` would tell mpv a local file is a network stream.
 *
 * A split video pick is the exception: `audioUrl` and `headers` have nowhere to
 * ride through the generic classifier, and a split pair is always http anyway.
 */
export function selectedNeedsClassifying(sel: SelectedStream): boolean {
  if (sel.audioUrl) return false;
  return !/^https?:\/\//.test(sel.url);
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
    // Only the video rung steps down. The companion audio stream is small,
    // and nothing suggests it is what a refusal was about — stepping it too
    // would trade audio quality away for no reason.
    const videoOnly = pickBest(candidates, (c) => c.kind === "video", commonVideo, ctx.skipTopVideo ?? 0);
    const audioOnly = pickByQuality(candidates, (c) => c.kind === "audio", commonAudio);
    if (videoOnly && audioOnly) {
      return { url: videoOnly.url, audioUrl: audioOnly.url, headers: videoOnly.headers, video: true };
    }
    // No usable split pair — the best self-contained stream. Some sources
    // expose a single HLS/DASH manifest tagged `muxed`; as a last resort take
    // the best video candidate so there is at least a picture.
    const muxed =
      pickBest(candidates, (c) => c.kind === "muxed", commonVideo) ??
      pickBest(candidates, isVideoKind, commonVideo);
    if (muxed) return { url: muxed.url, headers: muxed.headers, video: true };
    return null;
  }

  // Audio: prefer a pure audio-only stream (a muxed stream would pull video
  // bytes we don't need) and only fall back to muxed when no audio-only exists.
  const bestAudio =
    pickByQuality(candidates, (c) => c.kind === "audio", commonAudio) ??
    pickByQuality(candidates, isAudioKind, commonAudio);
  if (!bestAudio) return null;
  return { url: bestAudio.url, headers: bestAudio.headers, video: false };
}
