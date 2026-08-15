// Pure lyrics helpers shared by the Now Playing view (karaoke highlighting) and
// the Now Playing info cycler (current/random line items). Dependency-free and
// unit-tested.

export interface LrcLine {
  time: number;
  text: string;
}

/** Parse LRC-formatted text (`[mm:ss.cc]line`) into timed lines, in order. */
export function parseLrc(lrc: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const raw of lrc.split("\n")) {
    const match = raw.match(/^\[(\d{2}):(\d{2})(?:[.:](\d{2,3}))?\](.*)$/);
    if (match) {
      const mins = parseInt(match[1], 10);
      const secs = parseInt(match[2], 10);
      const cs = match[3] ? parseInt(match[3], 10) / (match[3].length === 3 ? 1000 : 100) : 0;
      lines.push({ time: mins * 60 + secs + cs, text: match[4].trim() });
    }
  }
  return lines;
}

/** Nudge step for the offset control; Shift takes the coarse one. A music-video
 *  intro is commonly 10-30s, which 0.5s alone would make a clicking exercise. */
export const LYRIC_OFFSET_STEP = 0.5;
export const LYRIC_OFFSET_COARSE_STEP = 5;
/** Past a minute the lyrics are for a different recording, not out of sync. */
export const LYRIC_OFFSET_MAX = 60;

/**
 * Playback position translated into the lyrics' own timeline.
 *
 * **Positive `offsetSecs` DELAYS the lyrics.** A music video with a 15s intro
 * plays the first sung word at position 15 while the LRC times it at 0, so the
 * user asks for "+15s" and we look up the line at `20 - 15 = 5` when 20s have
 * played. That is the direction people mean by "the subtitles are early".
 *
 * A one-line subtraction behind a name on purpose: the sign is the thing that
 * gets flipped, and it is applied at four call sites. Pinning it here means one
 * test covers all of them.
 */
export function lyricPosition(position: number, offsetSecs: number): number {
  return position - offsetSecs;
}

/** Clamp to the supported range and quantise to 0.1s — the offset is user-typed
 *  arithmetic on floats, and `0.5 + 0.5 + 0.5` should read as `1.5`, not
 *  `1.5000000000000002`. */
export function clampLyricOffset(secs: number): number {
  if (!Number.isFinite(secs)) return 0;
  const clamped = Math.max(-LYRIC_OFFSET_MAX, Math.min(LYRIC_OFFSET_MAX, secs));
  return Math.round(clamped * 10) / 10;
}

/** Signed, one-decimal label for the offset readout. Uses a true minus sign
 *  (U+2212) rather than a hyphen so it aligns with the `+` at the same width. */
export function formatLyricOffset(secs: number): string {
  const v = clampLyricOffset(secs);
  if (v === 0) return "0.0s";
  const sign = v > 0 ? "+" : "−";
  return `${sign}${Math.abs(v).toFixed(1)}s`;
}

/** Storage key for a track's lyric offset. Metadata-keyed, matching the
 *  information-type cache (`track:{artist}:{title}`) — a `QueueTrack` has no DB
 *  id, and the same recording should keep its offset across sources. */
export function lyricOffsetKey(track: { title: string; artist_name?: string | null }): string {
  return `track:${(track.artist_name ?? "").toLowerCase()}:${track.title.toLowerCase()}`;
}

/** Index of the active synced line at `position` seconds (the last line whose
 *  timestamp has passed), or -1 before the first line. */
export function currentSyncedLineIndex(lines: LrcLine[], position: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= position) idx = i;
    else break;
  }
  return idx;
}

/** The synced lyric line being sung at `position` seconds, or null when nothing
 *  is currently sung: before the first line (intro) or while the active line is
 *  blank — the timestamped empty lines LRC uses to mark intros/instrumental
 *  breaks. Unlike a walk-back lookup, this lets the Now Playing info item drop
 *  out of the cycle during those gaps instead of lingering on a stale line. */
export function activeSyncedLine(lines: LrcLine[], position: number): string | null {
  const idx = currentSyncedLineIndex(lines, position);
  if (idx < 0) return null;
  const text = lines[idx].text.trim();
  return text ? text : null;
}

/** Coarse sanity check that a synced LRC belongs to a track of roughly this
 *  media length — used to gate lyrics-over-video. Two-sided, because a wrong
 *  match runs long in either direction:
 *
 *  - lyrics running well PAST the media (a 30s preview, or a shorter edit) —
 *    rejected beyond `toleranceSecs`;
 *  - lyrics covering only a sliver of the media (a 3-minute song's LRC against
 *    an 80-minute concert upload, a DJ set, or an extended remix whose timings
 *    won't line up anyway) — rejected below `minCoverage` of the duration.
 *
 *  60% coverage passes an ordinary music video with an intro and an outro
 *  (4:30 video, last line at 3:20 → 0.74) while rejecting the long-upload
 *  cases. The cost is a false negative on a track with a very long instrumental
 *  outro; hiding lyrics there is the safer miss.
 *
 *  Unknown duration → allow (hiding lyrics because we can't measure would be
 *  worse than the status quo). Does NOT detect an intro offset (video timelines
 *  can differ from the audio release) — that's a manual-offset concern. */
export function syncedLyricsFitMedia(
  lines: LrcLine[],
  mediaDurationSecs: number | null | undefined,
  toleranceSecs = 10,
  minCoverage = 0.6,
): boolean {
  if (!mediaDurationSecs || mediaDurationSecs <= 0) return true;
  if (!lines.length) return false;
  const lastTime = lines[lines.length - 1].time;
  if (lastTime > mediaDurationSecs + toleranceSecs) return false;
  return lastTime >= mediaDurationSecs * minCoverage;
}

/** Non-empty, trimmed lines of plain (unsynced) lyrics text. */
export function plainLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

/** Pick a line by a [0,1) ratio. Deterministic given the ratio, so callers can
 *  feed a stable seed and keep the pick steady across re-renders. null if empty. */
export function pickLineByRatio(lines: string[], ratio: number): string | null {
  if (lines.length === 0) return null;
  const clamped = ratio < 0 ? 0 : ratio >= 1 ? 1 - Number.EPSILON : ratio;
  return lines[Math.floor(clamped * lines.length)];
}

/** Deterministic [0,1) ratio from a string (FNV-1a). Lets a "random" line pick
 *  stay stable for a given track instead of flickering on every render/cycle. */
export function hashStringToRatio(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}
