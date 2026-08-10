import { useEffect, useMemo, useRef, useState } from "react";
import { tileCoverStyle, tileIndexAt, type Storyboard, type TileStyle } from "../utils/storyboard";
import "./FilmstripSeekBar.css";

interface FilmstripSeekBarProps {
  board: Storyboard;
  /** Track length in seconds — the strip maps x to time against THIS, not the
   *  storyboard's own span, so a board that under-covers leaves blank tail cells. */
  durationSecs: number;
  progress: number; // 0..1
  /** Cursor position as a 0..1 fraction, or null when not hovering. */
  hoverPct?: number | null;
  /** How far the source has downloaded, as a 0..1 fraction, or null when the
   *  engine can't say (any local file). Frames past the edge are knocked back
   *  further than the ordinary ahead-of-playhead treatment. This matters more
   *  here than on the audio bars: a storyboard means a streamed video, which
   *  is the source most likely to stall. */
  bufferedPct?: number | null;
}

/** Height of each perforation rail. The frames get whatever is left, so this is the
 *  one number that trades film-ness against frame size. */
const RAIL_PX = 5;
const RAIL_PX_COMPACT = 4; // shorter bars (the fullscreen overlay) can't spare 10px
const COMPACT_HEIGHT = 32;
/** Never slice the strip finer than this — sub-24px frames read as noise. */
const MIN_SLOT_PX = 24;

export interface Cell {
  /** Null where the storyboard doesn't reach — rendered as an empty gate rather than
   *  repeating a neighbouring frame, which would misrepresent the timeline. */
  style: TileStyle | null;
  width: number;
  /** Midpoint of this cell as a 0..1 fraction, for the played/unplayed split. */
  mid: number;
}

/**
 * Lay the strip out: one cell per evenly-spaced moment, at integer widths that sum
 * back to the exact track width (a fractional width per cell accumulates into a
 * visible gap at the right edge).
 */
export function planCells(
  board: Storyboard,
  width: number,
  height: number,
  frameH: number,
  durationSecs: number,
): Cell[] {
  if (width <= 0 || frameH <= 0 || durationSecs <= 0) return [];
  const slot = Math.max(MIN_SLOT_PX, Math.round(frameH * (board.tileW / board.tileH)));
  // Cap at the tile count so cells never repeat a frame — past that point the strip
  // would imply detail the storyboard doesn't have.
  const n = Math.max(1, Math.min(board.count, Math.round(width / slot)));

  const cells: Cell[] = [];
  let used = 0;
  for (let i = 0; i < n; i++) {
    // Distribute the remainder instead of rounding each cell independently.
    const end = Math.round(((i + 1) * width) / n);
    const w = end - used;
    used = end;
    const mid = (i + 0.5) / n;
    const idx = tileIndexAt(board, mid * durationSecs);
    cells.push({
      // Cover-crop: the slot is 16:9 against the *frame* area, but the tile is drawn
      // across the full height and the rails overlay it, so it must fill that box.
      style: idx == null ? null : tileCoverStyle(board, idx, w, height),
      width: w,
      mid,
    });
  }
  return cells;
}

/**
 * A video's seek bar: the storyboard itself, laid out as a filmstrip.
 *
 * Video never gets a waveform (`useWaveform` bails on it outright), so there is nothing
 * to overlay here — the frames are the seek surface. Frames ahead of the playhead are
 * desaturated so progress reads as a colour front, and the playhead is a needle plus
 * carets that bite in from the perforation rails, where they cost no frame area.
 *
 * Frames past the *buffered* edge are knocked back a second step. Both boundaries land
 * on a frame edge (they test the cell midpoint), which suits a filmstrip — the needle
 * carries the exact position.
 *
 * Tiles are drawn with background offsets rather than a canvas, matching `StoryboardTile`
 * — nothing reads pixels, so cross-origin (plugin-supplied) sheets never taint anything.
 */
export function FilmstripSeekBar({
  board, durationSecs, progress, hoverPct = null, bufferedPct = null,
}: FilmstripSeekBarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const r = el.getBoundingClientRect();
      setBox(prev => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rail = box.h > 0 && box.h < COMPACT_HEIGHT ? RAIL_PX_COMPACT : RAIL_PX;
  const frameH = Math.max(1, box.h - rail * 2);

  const cells = useMemo(
    () => planCells(board, box.w, box.h, frameH, durationSecs),
    [board, box.w, box.h, frameH, durationSecs],
  );

  const clamped = Math.min(1, Math.max(0, progress));
  // Null (no engine report) means the whole strip counts as available, which is
  // the pre-existing single-step rendering.
  const bufferedEdge = bufferedPct != null ? Math.min(1, Math.max(0, bufferedPct)) : 1;

  return (
    <div className="filmstrip" ref={ref}>
      <div className="filmstrip-cells">
        {cells.map((c, i) => (
          <div
            key={i}
            className={`filmstrip-cell${c.mid > clamped ? " filmstrip-cell--ahead" : ""}${c.mid > bufferedEdge ? " filmstrip-cell--unbuffered" : ""}`}
            style={{ ...(c.style ?? undefined), width: c.width }}
          />
        ))}
      </div>

      <div className="filmstrip-rail filmstrip-rail--top" style={{ height: rail }} />
      <div className="filmstrip-rail filmstrip-rail--bottom" style={{ height: rail }} />

      {hoverPct != null && (
        <div className="filmstrip-hover" style={{ left: `${hoverPct * 100}%` }} />
      )}

      <div className="filmstrip-head" style={{ left: `${clamped * 100}%` }}>
        <i className="filmstrip-caret filmstrip-caret--top" />
        <i className="filmstrip-caret filmstrip-caret--bottom" />
      </div>
    </div>
  );
}
