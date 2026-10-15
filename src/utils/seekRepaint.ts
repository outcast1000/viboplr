// The seek bars repaint their whole canvas whenever an input changes, and the
// play position changes ~4×/sec for as long as music plays. On a 700px bar a
// 4-minute song moves under one pixel per tick, and an hour-long video a
// fifth of a pixel — most of those repaints draw exactly the frame already on
// screen, and on a transparent window each one makes macOS recomposite.
//
// `seekPaintKey` names what a repaint would actually look like: every
// fractional input rounded to the whole CSS pixel it lands on. A draw whose
// key matches the last one painted can skip the canvas entirely.

export interface SeekPaintInputs {
  /** 0..1 */
  progress: number;
  /** CSS pixels. */
  width: number;
  height: number;
  /** 0..1, or null when nothing is hovered. */
  hoverPct: number | null;
  /** 0..1, or null when the buffer is unknown. */
  bufferedPct: number | null;
  /** Anything else the picture depends on (colours, data identity). */
  extra?: string;
}

const px = (fraction: number | null, width: number) =>
  fraction == null ? "-" : String(Math.round(fraction * width));

export function seekPaintKey(i: SeekPaintInputs): string {
  return [
    i.width,
    i.height,
    px(i.progress, i.width),
    px(i.hoverPct, i.width),
    px(i.bufferedPct, i.width),
    i.extra ?? "",
  ].join("|");
}

/** For a DOM progress fill whose width isn't known at render time: snap a
 *  0..1 fraction to `steps` positions. Pick `steps` at least the widest the
 *  fill gets in CSS pixels, so a step is never more than a pixel — the style
 *  (and so the paint) then changes only when the fill visibly moves. */
export function quantizeFraction(fraction: number, steps: number): number {
  const f = Math.min(1, Math.max(0, fraction));
  return Math.round(f * steps) / steps;
}
