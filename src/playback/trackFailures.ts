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

/** How one resolver-chain entry ended. `unplayable`: its source resolved on an
 *  earlier walk but the engine couldn't open it, so this walk skipped it
 *  (playbackRetry.fallBackFromFailedSource). */
export type ResolverOutcome = "found" | "miss" | "no-video" | "timeout" | "error" | "unplayable";

export interface ResolverAttempt {
  /** The entry's display name ("Library", "yt-dlp", "Direct URL"…). */
  name: string;
  outcome: ResolverOutcome;
  /** The thrown error's text, for `error` (and `timeout`). Never shown on the row. */
  detail?: string | null;
  /** A plugin playback fallback that was asked and came back without it — not
   *  the track's own source, not the Library lookup. */
  fallback?: boolean;
}

/** How far the play got before it failed:
 *  - "engine": libmpv isn't loaded, so nothing was even asked for a source.
 *  - "resolve": no source was found (or none could be asked).
 *  - "playback": a source was handed to the engine and it couldn't open it. */
export type TrackFailureStage = "engine" | "resolve" | "playback";

export interface TrackFailure {
  stage: TrackFailureStage;
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
  /** The play was a row's play button, so only the entry's own source was
   *  tried (usePlayback.handlePlay). Try again keeps that restriction, and no
   *  fallback plugin is suggested — the row wouldn't ask one. */
  ownSourceOnly?: boolean;
}

/** The message `useStreamResolution` throws once the whole chain came back
 *  empty. `handlePlay` reports it again on its way out; that report must not
 *  replace the richer `resolve` record the chain already wrote. */
export const CHAIN_EXHAUSTED_MESSAGE = "Couldn't find a playable source for this track";

/**
 * Merge an incoming failure into the entry's existing one.
 *
 * The chain records a `resolve` failure with every attempt; `handlePlay` then
 * reports the same failure again with no attempts — as the bare chain message,
 * or refined (offline). Keep the chain's attempts; take a refined summary,
 * since it names the real cause. Anything else is a newer failure and replaces
 * it.
 */
export function mergeTrackFailure(existing: TrackFailure | undefined, incoming: TrackFailure): TrackFailure {
  if (existing?.stage === "resolve" && incoming.stage === "resolve" && incoming.attempts.length === 0) {
    if (incoming.summary === CHAIN_EXHAUSTED_MESSAGE) return existing;
    return { ...existing, summary: incoming.summary, at: incoming.at };
  }
  return incoming;
}

const OUTCOME_TEXT: Record<ResolverOutcome, string> = {
  found: "Found a source",
  miss: "No match",
  "no-video": "No video stream",
  timeout: "Timed out",
  error: "Failed",
  unplayable: "Found, but wouldn't play",
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
      f.stage === "engine"
        ? "The player couldn't start on this machine, so no source was tried."
        : f.stage === "resolve"
          ? "None of your sources could find this track."
          : "A source was found, but the player couldn't open it.",
    rows,
    attempts: describeAttempts(f.attempts),
  };
}

function describeAttempts(attempts: ResolverAttempt[]): FailureDetails["attempts"] {
  return attempts.map((a) => ({
    name: a.name,
    outcome: a.name === "Library" && a.outcome === "miss" ? "Not in library" : OUTCOME_TEXT[a.outcome],
    detail: a.detail ?? null,
    found: a.outcome === "found",
  }));
}

/**
 * Which source an entry actually played from, when it wasn't simply its own.
 * Written by the resolver chain on a successful resolve that didn't land on the
 * entry's own source; read by the queue row's "via X" chip and its dialog.
 * Session-only, pruned with the entry.
 */
export interface EntrySourceNote {
  /** The winning entry's display name ("Soulseek", "yt-dlp", "Library"). */
  name: string;
  /** Why something other than the entry's own source played it:
   *  - `fallback`: it has a source of its own (a file, a server id, a plugin
   *    id) and that couldn't be used — the one case that is a degradation;
   *  - `no-source`: a metadata-only entry, which has none to use;
   *  - `prefer-video`: the "Prefer video" pass found a video for it, by choice. */
  reason: SourceNoteReason;
  /** Where the bytes come from, when the resolver said (a file, a page). */
  sourceUrl: string | null;
  /** The walk that found it, in order, ending with the `found` entry. */
  attempts: ResolverAttempt[];
  at: number;
}

export type SourceNoteReason = "fallback" | "no-source" | "prefer-video";

const SOURCE_NOTE_EXPLANATION: Record<SourceNoteReason, string> = {
  fallback: "This track's own source couldn't be used, so the next sources in line were asked.",
  "no-source": "This entry has no source of its own, so your playback sources were asked for a copy.",
  "prefer-video": "Prefer video is on, so your sources were asked for a video of this track first.",
};

/** The chip's hover text. */
export function sourceNoteChipTitle(n: EntrySourceNote): string {
  const lead = n.reason === "fallback"
    ? `Its own source couldn't be used. Played from ${n.name}.`
    : n.reason === "prefer-video"
      ? `Prefer video: played the video from ${n.name}.`
      : `Played from ${n.name}.`;
  return `${lead} Show what was tried.`;
}

/** The note's address as the user would paste it: the file path for a local
 *  file (the app's `file://` URIs carry the raw path — same rule as
 *  `effectiveLocalPath`), else the URL as reported. */
export function sourceNoteAddress(n: EntrySourceNote): string | null {
  if (!n.sourceUrl) return null;
  return n.sourceUrl.startsWith("file://") ? n.sourceUrl.slice("file://".length) || null : n.sourceUrl;
}

export interface SourceNoteDetails {
  headline: string;
  explanation: string;
  rows: FailureDetailRow[];
  attempts: FailureDetails["attempts"];
}

/** Plain-language account of a source note, for its details dialog. */
export function describeSourceNote(n: EntrySourceNote, now: number = Date.now()): SourceNoteDetails {
  const rows: FailureDetailRow[] = [{ label: "Source", value: n.name }];
  const address = sourceNoteAddress(n);
  if (address) rows.push({ label: "Address", value: address, code: true });
  rows.push({ label: "When", value: relativeTime(n.at, now) });
  return {
    headline: `Played from ${n.name}`,
    explanation: SOURCE_NOTE_EXPLANATION[n.reason],
    rows,
    attempts: describeAttempts(n.attempts),
  };
}

/** Lines for the "Report a problem" context block, from a source note. */
export function sourceNoteReportLines(
  n: EntrySourceNote,
  track: { title: string; artist_name: string | null; album_title?: string | null },
): string[] {
  const address = sourceNoteAddress(n);
  return [
    `Track: ${track.title}${track.artist_name ? ` — ${track.artist_name}` : ""}`,
    ...(track.album_title ? [`Album: ${track.album_title}`] : []),
    `Played from: ${n.name} (${n.reason})`,
    ...(address ? [`Address: ${address}`] : []),
    ...describeAttempts(n.attempts).map((a) => `Resolver ${a.name}: ${a.outcome}${a.detail ? ` (${a.detail})` : ""}`),
  ];
}

/** Lines for the "Report a problem" context block. */
export function trackFailureReportLines(
  f: TrackFailure,
  track: { title: string; artist_name: string | null; album_title?: string | null },
): string[] {
  const d = describeTrackFailure(f);
  return [
    `Track: ${track.title}${track.artist_name ? ` — ${track.artist_name}` : ""}`,
    ...(track.album_title ? [`Album: ${track.album_title}`] : []),
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
