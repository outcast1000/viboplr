import { FilmstripSeekBar } from "./FilmstripSeekBar";
import { WaveformSeekBar } from "./WaveformSeekBar";
import { SegmentedSeekBar } from "./SegmentedSeekBar";
import { StoryboardTile } from "./StoryboardTile";
import { formatDuration } from "../utils";
import { tileIndexAt, type Storyboard } from "../utils/storyboard";

/**
 * Bubble thumbnail width.
 *
 * This is the control that answers "what is at 2:41?" — the strip itself answers
 * "where are the cuts". Sized accordingly: 176px was small enough that the two
 * were competing at the same job and neither won. Sheet tiles are larger (up to
 * 400px) to serve the hero art, so this still downscales, and percentage-based
 * positioning keeps it sharp.
 */
const SEEK_THUMB_WIDTH = 240;

/** Pointer position over a seek track: `pct` along the track, `x` in px inside
 *  the *wrapper*. The two differ because the track clips (`overflow: hidden`)
 *  so the bubble has to live in the wrapper, and it is positioned against that. */
export interface SeekHover {
  pct: number;
  x: number;
}

/** Read a `SeekHover` off a mouse event over a seek track. Shared so the two
 *  bars can't drift on the clamp or on which element the bubble is measured
 *  against — the wrapper, never the track. */
export function seekHoverAt(e: React.MouseEvent<HTMLElement>, wrap: HTMLElement | null): SeekHover {
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const wrapLeft = wrap?.getBoundingClientRect().left ?? rect.left;
  return { pct, x: e.clientX - wrapLeft };
}

/**
 * Does this track's seek bar render as a filmstrip?
 *
 * The one condition that makes the bar worth expanding on hover — a waveform or a
 * segmented bar gains nothing from height it doesn't use. Exported (rather than
 * re-tested at each host) because `SeekLadder` branches on exactly this, and a
 * host that disagreed would expand a bar with no frames in it.
 */
export function hasFilmstrip(storyboard: Storyboard | null, durationSecs: number): boolean {
  return !!storyboard && durationSecs > 0;
}

interface SeekLadderProps {
  storyboard: Storyboard | null;
  waveformPeaks: number[] | null;
  positionSecs: number;
  durationSecs: number;
  hoverPct: number | null;
  bufferedPct: number | null;
}

/**
 * Which seek rendering a track gets, in one place.
 *
 * A track must not change its seek surface just because the window went
 * fullscreen, so both bars call this rather than each writing the ladder out.
 * Video usually has a storyboard; audio never does and falls to the waveform
 * (local-only), then to the segmented bar — which is what a NETWORK audio track
 * actually gets, and which draws its own buffered edge. `WaveformSeekBar` takes
 * no `bufferedPct` on purpose: a waveform exists only for `file://` sources and
 * a buffer only for network ones, so the two can never co-occur.
 */
export function SeekLadder({
  storyboard, waveformPeaks, positionSecs, durationSecs, hoverPct, bufferedPct,
}: SeekLadderProps) {
  if (hasFilmstrip(storyboard, durationSecs)) {
    return (
      <FilmstripSeekBar
        // Non-null by hasFilmstrip; the narrowing doesn't survive the call.
        board={storyboard!}
        durationSecs={durationSecs}
        progress={positionSecs / durationSecs}
        hoverPct={hoverPct}
        bufferedPct={bufferedPct}
      />
    );
  }
  if (waveformPeaks) {
    return (
      <WaveformSeekBar
        peaks={waveformPeaks}
        progress={durationSecs > 0 ? positionSecs / durationSecs : 0}
        hoverPct={hoverPct}
      />
    );
  }
  if (durationSecs > 0) {
    return (
      <SegmentedSeekBar
        progress={positionSecs / durationSecs}
        durationSecs={durationSecs}
        bufferedPct={bufferedPct}
      />
    );
  }
  // No duration (a live stream): nothing can lay out a track.
  return null;
}

interface SeekHoverBubbleProps {
  hover: SeekHover | null;
  storyboard: Storyboard | null;
  positionSecs: number;
  durationSecs: number;
  /** Host's bubble class — the two bars anchor and colour it differently. */
  className: string;
  /** Host's class for the ± offset span. */
  deltaClassName: string;
}

/**
 * The scrub preview: the time you would land on, the ± offset from where you
 * are, and a storyboard frame when the track has one.
 *
 * The ± offset is the reason this is shared rather than written twice — it went
 * missing from the fullscreen bar for exactly as long as the two were separate
 * copies. Only the class names differ between hosts.
 */
export function SeekHoverBubble({
  hover, storyboard, positionSecs, durationSecs, className, deltaClassName,
}: SeekHoverBubbleProps) {
  if (!hover || durationSecs <= 0) return null;
  const hoverSecs = hover.pct * durationSecs;
  // Resolved up front: the bubble only switches to the column layout when a tile
  // actually exists, and a storyboard may not cover every moment.
  const tile = storyboard ? tileIndexAt(storyboard, hoverSecs) : null;
  return (
    <div
      className={`${className}${tile !== null ? " has-thumb" : ""}`}
      style={{ left: hover.x }}
    >
      {tile !== null && storyboard && (
        <StoryboardTile
          board={storyboard}
          index={tile}
          className="seek-preview-thumb"
          width={SEEK_THUMB_WIDTH}
          height={Math.round(SEEK_THUMB_WIDTH * (storyboard.tileH / storyboard.tileW))}
        />
      )}
      <span>
        {formatDuration(hoverSecs)}
        <span className={deltaClassName}>
          {(hoverSecs >= positionSecs ? "+" : "-") +
            formatDuration(Math.abs(hoverSecs - positionSecs))}
        </span>
      </span>
    </div>
  );
}
