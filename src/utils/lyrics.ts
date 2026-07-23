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
 *  media length — used to gate lyrics-over-video. Rejects only when the lyrics
 *  run well PAST the media (a short clip/preview, or the wrong/shorter video);
 *  a long instrumental/extended video is fine (the lyrics simply end early).
 *  Unknown duration → allow. Does NOT detect an intro offset (video timelines
 *  can differ from the audio release) — that's a manual-offset concern. */
export function syncedLyricsFitMedia(
  lines: LrcLine[],
  mediaDurationSecs: number | null | undefined,
  toleranceSecs = 10,
): boolean {
  if (!mediaDurationSecs || mediaDurationSecs <= 0) return true;
  if (!lines.length) return false;
  return lines[lines.length - 1].time <= mediaDurationSecs + toleranceSecs;
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
