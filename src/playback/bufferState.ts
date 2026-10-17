// Buffer/readahead state for the track currently playing: "is playback
// stalled waiting for data" and "how far ahead is data available", from the
// engine's `engine-buffer` event (mpv's `paused-for-cache`,
// `demuxer-cache-time`, `demuxer-cache-duration`).
//
// `null` means *unknown*, not *nothing buffered*. A local file often reports
// nothing at all, and rendering "0% buffered" for a file sitting on disk would
// be a lie — every consumer treats null as "don't draw a buffered edge".
//
// Note there is deliberately no refill *percentage* here. mpv's
// `cache-buffering-state` reads a near-constant 0 through a real stall (it
// unpauses as soon as ~1s is cached, so it is only ever "buffering" while the
// cache is near empty — observed against a throttled HTTP source), which made
// the chip read a static "Buffering… 0%". Seconds of readahead is the number
// that actually moves.

export interface PlaybackBuffer {
  /** Playback is halted waiting for data. */
  stalled: boolean;
  /** Seconds of audio buffered beyond the play position, or null when the
   *  engine can't say. Only meaningful (and only shown) while stalled. */
  readaheadSecs: number | null;
  /** Absolute track position (secs) that buffered data reaches, or null. */
  bufferedToSecs: number | null;
}

/** How close (secs) the buffered edge may sit to the duration and still count
 *  as fully buffered. A fully cached stream never reports its edge *at* the
 *  duration: mpv's `demuxer-cache-time` tops out at the last packet's
 *  timestamp (measured 59.98s for a 60.0s file — see the engine's
 *  `probe_buffered_edge_vs_duration`), and a metadata duration (subsonic
 *  stores whole seconds) can sit up to a second past the real timeline. The
 *  seek bars deliberately keep the unbuffered fade on-or-before the edge, so
 *  without this snap the final block of every fully-downloaded remote track
 *  stayed dim forever. */
const FULL_SLACK_SECS = 2;

/** Buffered extent as a 0..1 fraction of the track, or null when unknown. */
export function bufferedFraction(
  bufferedToSecs: number | null,
  durationSecs: number,
): number | null {
  if (bufferedToSecs == null || !isFinite(bufferedToSecs)) return null;
  if (!isFinite(durationSecs) || durationSecs <= 0) return null;
  if (durationSecs - bufferedToSecs <= FULL_SLACK_SECS) return 1;
  return Math.min(1, Math.max(0, bufferedToSecs / durationSecs));
}

/** Readahead as a short label for the buffering chip, or null when unknown
 *  (the chip then shows the bare word). Sub-10s keeps a decimal because that
 *  is the range a stall actually lives in and a bare "0s" looks frozen; past
 *  that the tenths are noise. */
export function formatReadahead(secs: number | null): string | null {
  if (secs == null || !isFinite(secs) || secs < 0) return null;
  return secs < 10 ? `${secs.toFixed(1)}s` : `${Math.round(secs)}s`;
}

function sameBuffer(a: PlaybackBuffer, b: PlaybackBuffer): boolean {
  return (
    a.stalled === b.stalled &&
    a.readaheadSecs === b.readaheadSecs &&
    a.bufferedToSecs === b.bufferedToSecs
  );
}

/** Fold a partial update into the previous state. Returns the previous object
 *  identity when nothing moved, so React bails out of the re-render — a
 *  filling stream reports several times a second and would otherwise
 *  re-render the whole now-playing bar for no visible change. */
export function applyBuffer(
  prev: PlaybackBuffer | null,
  patch: Partial<PlaybackBuffer>,
): PlaybackBuffer {
  const base: PlaybackBuffer = prev ?? { stalled: false, readaheadSecs: null, bufferedToSecs: null };
  const next: PlaybackBuffer = { ...base, ...patch };
  return prev && sameBuffer(prev, next) ? prev : next;
}
