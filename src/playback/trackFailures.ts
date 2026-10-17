// Why a queue entry didn't play, kept per entry so the queue row can say so
// after the music has moved on, and a click on that note can explain it.
//
// Two stages fail differently and both used to be invisible in different ways:
//   - "resolve": every resolver in the chain came back empty — nothing to play.
//   - "playback": a source WAS found but the engine couldn't open it (an
//     expired or refused stream URL, a codec mpv can't decode, a moved file).
//     usePlayback retries a remote one with fresh sources first; only the final
//     failure lands here. These went to a toast or a modal and nowhere else, and
//     the retry's successful resolve wiped the row's note on the way.
//
// Pure — the hooks own the state, this owns the shape and the rules.

/** How one resolver-chain entry ended. */
export type ResolverOutcome = "found" | "miss" | "no-video" | "timeout" | "error";

export interface ResolverAttempt {
  /** The entry's display name ("Library", "yt-dlp", "Direct URL"…). */
  name: string;
  outcome: ResolverOutcome;
  /** The thrown error's text, for `error` (and `timeout`). Never shown on the row. */
  detail?: string | null;
}

export interface TrackFailure {
  stage: "resolve" | "playback";
  /** Short line shown after "Couldn't play · " on the queue row. */
  summary: string;
  /** Epoch ms of the (latest) failure. */
  at: number;
  /** The resolver chain's last walk for this entry, in order — including the
   *  entry that found the source a `playback` failure then couldn't open. */
  attempts: ResolverAttempt[];
  /** `playback` only: the source the engine was handed. */
  source?: { name: string; url: string | null } | null;
  /** `playback` only: the engine's own error text ("loading failed (-13)"). */
  engineError?: string | null;
  /** `playback` only: how many times the engine was asked to open it. */
  tries?: number | null;
}

/** The message `useStreamResolution` throws once the whole chain came back
 *  empty. `handlePlay` reports it again on its way out; that report must not
 *  replace the richer `resolve` record the chain already wrote. */
export const CHAIN_EXHAUSTED_MESSAGE = "Couldn't find a playable source for this track";

/**
 * Merge an incoming failure into the entry's existing one.
 *
 * The chain records a `resolve` failure with every attempt; `handlePlay` then
 * surfaces the same failure as a bare message. Keep the record that knows more.
 * Anything else is a newer failure and replaces it.
 */
export function mergeTrackFailure(existing: TrackFailure | undefined, incoming: TrackFailure): TrackFailure {
  if (existing?.stage === "resolve" && incoming.stage === "playback" && incoming.summary === CHAIN_EXHAUSTED_MESSAGE && !incoming.engineError) {
    return existing;
  }
  return incoming;
}

const OUTCOME_TEXT: Record<ResolverOutcome, string> = {
  found: "Found a source",
  miss: "No match",
  "no-video": "No video stream",
  timeout: "Timed out",
  error: "Failed",
};

export interface FailureDetailRow {
  label: string;
  value: string;
  /** Monospace — raw text the user may want to copy or quote. */
  code?: boolean;
}

export interface FailureDetails {
  headline: string;
  explanation: string;
  rows: FailureDetailRow[];
  attempts: { name: string; outcome: string; detail: string | null; found: boolean }[];
}

/**
 * Plain-language explanation for one failure — the details dialog renders this
 * as is, and the "Report a problem" context is built from the same rows.
 */
export function describeTrackFailure(f: TrackFailure, now: number = Date.now()): FailureDetails {
  const rows: FailureDetailRow[] = [];
  if (f.stage === "playback") {
    if (f.source) {
      rows.push({ label: "Source", value: f.source.name });
      if (f.source.url) rows.push({ label: "Address", value: f.source.url, code: true });
    }
    if (f.engineError) rows.push({ label: "Player error", value: f.engineError, code: true });
    if (f.tries && f.tries > 1) rows.push({ label: "Attempts", value: `Tried ${f.tries} times, with a fresh link each time` });
  }
  rows.push({ label: "When", value: relativeTime(f.at, now) });
  return {
    headline: f.summary,
    explanation:
      f.stage === "resolve"
        ? "None of your sources could find this track."
        : "A source was found, but the player couldn't open it.",
    rows,
    attempts: f.attempts.map((a) => ({
      name: a.name,
      outcome: a.name === "Library" && a.outcome === "miss" ? "Not in library" : OUTCOME_TEXT[a.outcome],
      detail: a.detail ?? null,
      found: a.outcome === "found",
    })),
  };
}

/** Lines for the "Report a problem" context block. */
export function trackFailureReportLines(f: TrackFailure, track: { title: string; artist_name: string | null }): string[] {
  const d = describeTrackFailure(f);
  return [
    `Track: ${track.title}${track.artist_name ? ` — ${track.artist_name}` : ""}`,
    `Stage: ${f.stage}`,
    `Error: ${f.summary}`,
    ...d.rows.filter((r) => r.label !== "When").map((r) => `${r.label}: ${r.value}`),
    ...d.attempts.map((a) => `Resolver ${a.name}: ${a.outcome}${a.detail ? ` (${a.detail})` : ""}`),
  ];
}

function relativeTime(at: number, now: number): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return "Just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
