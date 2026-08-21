// Seek-preview storyboards: a sprite sheet of small thumbnails laid out row-major.
// Consumers show one tile by offsetting the sheet behind a box — no canvas, so nothing
// reads pixels and cross-origin sheets never taint anything.
// See docs/seek-preview-spec.md.

/** Mirrors the Rust `storyboard::Storyboard` (camelCase over IPC). */
export interface Storyboard {
  /** Sheet paths/URLs in time order. The local producer emits exactly one. */
  sheets: string[];
  cols: number;
  rows: number;
  /**
   * Tiles that actually carry a frame. The grid may hold more — ffmpeg's `tile`
   * filter pads the remainder with black — so never address a tile at or past this.
   */
  count: number;
  tileW: number;
  tileH: number;
  startSecs: number;
  intervalSecs: number;
}

/** The subset of CSS a consumer spreads onto its box to show one tile. */
export interface TileStyle {
  backgroundImage: string;
  backgroundPosition: string;
  backgroundSize: string;
}

/**
 * Split a track path into its URL scheme and id (`ytdlp://abc` -> ytdlp + abc).
 * This is the storyboard producer routing decision: a plugin scheme is answered by
 * the owning plugin, `file` by the local ffmpeg pass. Null for a bare path, and for
 * a leading `://` (an empty scheme no plugin can own).
 */
export function schemeOf(path: string): { scheme: string; id: string } | null {
  const i = path.indexOf("://");
  if (i <= 0) return null;
  return { scheme: path.slice(0, i), id: path.slice(i + 3) };
}

/**
 * A usable `Storyboard` from the frames extracted *so far* while the real sheet
 * still generates (see `useStoryboard`'s `partial`). Each frame file becomes its
 * own 1x1 sheet, and `count` is the FINISHED board's tile count — so the layout
 * (cell plan, spread, timestamps) is final from the first frame, moments the
 * extraction hasn't reached yet resolve to no tile (the sheet-bounds check in
 * `tileIndexAt` / the style helpers), and frames fill in place as they land
 * instead of reflowing. Tile dims are nominal 16:9 — the real aspect is only
 * knowable from the finished sheet, and these only drive slot shape and bubble
 * sizing until it arrives.
 */
export function partialStoryboard(
  frames: string[],
  intervalSecs: number,
  count: number,
): Storyboard | null {
  if (frames.length === 0 || count <= 0 || !(intervalSecs > 0)) return null;
  return {
    sheets: frames,
    cols: 1,
    rows: 1,
    count,
    tileW: 400,
    tileH: 225,
    startSecs: 0,
    intervalSecs,
  };
}

/** Descriptor sanity, checked once so the style helpers can't divide by zero. */
function isUsable(board: Storyboard): boolean {
  return (
    board.sheets.length > 0 &&
    board.cols > 0 &&
    board.rows > 0 &&
    board.count > 0 &&
    board.tileW > 0 &&
    board.tileH > 0
  );
}

/**
 * Index of the tile covering `t` seconds, or null when the storyboard can't serve it
 * (before the first tile, past the last real tile, or a malformed descriptor).
 * Callers treat null as "no preview".
 */
export function tileIndexAt(board: Storyboard, t: number): number | null {
  if (!isUsable(board) || !(board.intervalSecs > 0)) return null;
  const i = Math.floor((t - board.startSecs) / board.intervalSecs);
  if (i < 0 || i >= board.count) return null;
  // A descriptor may claim more tiles than the supplied sheets can hold.
  if (Math.floor(i / (board.cols * board.rows)) >= board.sheets.length) return null;
  return i;
}

/** Timestamp the given tile depicts — for captions and click-to-seek. */
export function tileStartSecs(board: Storyboard, i: number): number {
  return board.startSecs + i * board.intervalSecs;
}

function locate(board: Storyboard, i: number) {
  const perSheet = board.cols * board.rows;
  const sheet = Math.floor(i / perSheet);
  const n = i % perSheet;
  return { sheet, col: n % board.cols, row: Math.floor(n / board.cols) };
}

/**
 * Show tile `i` in a box that already has the tile's aspect ratio, scaling to whatever
 * size the box happens to be.
 *
 * Uses percentage background sizing rather than pixel offsets, so one style works at
 * any rendered width — the seek bubble draws at natural size while the filmstrip
 * stretches tiles across a flex row, and neither needs to measure itself.
 */
export function tileFitStyle(board: Storyboard, i: number): TileStyle | null {
  if (!isUsable(board) || i < 0 || i >= board.count) return null;
  const { sheet, col, row } = locate(board, i);
  const src = board.sheets[sheet];
  if (!src) return null;
  // With background-size N*100%, the sheet is N boxes wide, so each tile is exactly
  // one box; position % interpolates across the (N-1) box-widths of overflow.
  const xPct = board.cols > 1 ? (col / (board.cols - 1)) * 100 : 0;
  const yPct = board.rows > 1 ? (row / (board.rows - 1)) * 100 : 0;
  return {
    backgroundImage: `url("${src}")`,
    backgroundPosition: `${xPct}% ${yPct}%`,
    backgroundSize: `${board.cols * 100}% ${board.rows * 100}%`,
  };
}

/**
 * Show tile `i` filling a box of a *different* aspect ratio, cropping the overflow
 * centrally — the `object-fit: cover` equivalent. Needed where the box shape is fixed
 * by the surrounding UI (e.g. square track cards showing 16:9 tiles).
 *
 * Percentages can't express this, so it works in pixels and therefore needs the box
 * size up front.
 */
export function tileCoverStyle(
  board: Storyboard,
  i: number,
  boxW: number,
  boxH: number,
): TileStyle | null {
  if (!isUsable(board) || i < 0 || i >= board.count) return null;
  if (boxW <= 0 || boxH <= 0) return null;
  const { sheet, col, row } = locate(board, i);
  const src = board.sheets[sheet];
  if (!src) return null;
  // Scale so the tile covers the box on both axes, then centre the overflow.
  const k = Math.max(boxW / board.tileW, boxH / board.tileH);
  const tw = board.tileW * k;
  const th = board.tileH * k;
  const x = -(col * tw + (tw - boxW) / 2);
  const y = -(row * th + (th - boxH) / 2);
  return {
    backgroundImage: `url("${src}")`,
    backgroundPosition: `${round(x)}px ${round(y)}px`,
    backgroundSize: `${round(board.cols * tw)}px ${round(board.rows * th)}px`,
  };
}

// Sub-pixel background offsets cause visible seams between tiles; snap to integers.
// -0 is normalized away because it reads oddly in styles and in equality checks.
function round(v: number): number {
  const r = Math.round(v);
  return r === 0 ? 0 : r;
}

/**
 * Pick `n` tile indices evenly spread across the real tiles — for surfaces that want
 * a handful of representative moments (e.g. the filmstrip) rather than one at a
 * position. Always includes the first and last tile; returns fewer than `n` if there
 * aren't that many tiles.
 */
export function spreadTileIndices(board: Storyboard, n: number): number[] {
  return spreadIndices(board.count, n);
}

/** Count-based core of `spreadTileIndices`, for callers that don't hold a full
 *  descriptor yet — e.g. the filmstrip spreading a partially-extracted frame set. */
export function spreadIndices(count: number, n: number): number[] {
  if (n <= 0 || count <= 0) return [];
  if (n >= count) return Array.from({ length: count }, (_, i) => i);
  const step = (count - 1) / (n - 1 || 1);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const i = Math.round(k * step);
    if (out[out.length - 1] !== i) out.push(i);
  }
  return out;
}
