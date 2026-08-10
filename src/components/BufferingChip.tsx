import { formatReadahead, type PlaybackBuffer } from "../playback/bufferState";
import "./BufferingChip.css";

interface BufferingChipProps {
  buffer: PlaybackBuffer | null | undefined;
}

/** "Buffering…" overlay for a stalled network stream, shared by the now-playing
 *  bar and the fullscreen controls.
 *
 *  It renders *over* the seek track rather than beside it: a chip that takes
 *  layout would shove the waveform sideways every time a stream hiccups, and a
 *  bar that jumps on every stall is worse than no indicator at all.
 *
 *  Not a toast, deliberately — toasts dismiss after 4.5s and a stall can last
 *  far longer than that. The chip is present for exactly as long as the stall.
 *
 *  The number is **seconds of audio recovered**, not a percentage. mpv's
 *  `cache-buffering-state` sits at a near-constant 0 through a real stall
 *  (it unpauses the moment ~1s is cached, so it is only ever "buffering" while
 *  the cache is near empty), which rendered a static "Buffering… 0%" that read
 *  like a frozen UI. Readahead climbs, so it answers the question the user is
 *  actually asking: is this recovering or not? It degrades to the bare word
 *  when no engine could supply a figure. */
export function BufferingChip({ buffer }: BufferingChipProps) {
  if (!buffer?.stalled) return null;
  const readahead = formatReadahead(buffer.readaheadSecs);
  return (
    <div
      className="buffering-chip"
      role="status"
      title={
        readahead
          ? `Waiting for the stream to catch up — ${readahead} of audio recovered so far`
          : "Waiting for the stream to catch up"
      }
    >
      <span className="buffering-chip-spinner" aria-hidden="true" />
      <span>{readahead ? `Buffering… ${readahead}` : "Buffering…"}</span>
    </div>
  );
}
