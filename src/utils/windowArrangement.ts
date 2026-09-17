/**
 * Per-display-arrangement window geometry.
 *
 * macOS moves (and sometimes resizes) windows itself when a display is
 * plugged or unplugged, and those OS-driven moves fire the same
 * onMoved/onResized events as a user drag — so a single saved geometry gets
 * overwritten with the evacuation position the moment an external screen
 * disappears. Geometry is therefore keyed by a signature of the monitor set:
 * each desk setup (laptop-only, docked, …) remembers its own position, and
 * docking back restores it.
 *
 * The signature is built from PHYSICAL monitor coordinates plus the scale
 * factor (×100, rounded to an integer, so no float formatting is involved),
 * sorted so enumeration order can't change it. The Rust startup restore
 * computes the SAME string from the same values (`window_arrangement.rs`) —
 * keep the two implementations in step, and bump both together if the format
 * ever changes.
 */

export interface MonitorInfo {
  /** Physical position. */
  x: number;
  y: number;
  /** Physical size. */
  width: number;
  height: number;
  scaleFactor: number;
}

/** Full-window geometry remembered per arrangement (logical px). */
export interface FullWindowGeom { w: number; h: number; x: number; y: number }

/** Mini-player geometry remembered per arrangement (logical px). Size is
 *  derived from the resting/width presets, so only the position is kept. */
export interface MiniWindowGeom { x: number; y: number }

/** Shape of a Tauri `Monitor` as far as the signature needs it. */
export interface TauriMonitorLike {
  position: { x: number; y: number };
  size: { width: number; height: number };
  scaleFactor: number;
}

export function toMonitorInfo(m: TauriMonitorLike): MonitorInfo {
  return {
    x: m.position.x,
    y: m.position.y,
    width: m.size.width,
    height: m.size.height,
    scaleFactor: m.scaleFactor,
  };
}

export function arrangementSignature(monitors: MonitorInfo[]): string {
  return monitors
    .map(m => ({ ...m, s: Math.round(m.scaleFactor * 100) }))
    .sort((a, b) =>
      a.x - b.x || a.y - b.y || a.width - b.width || a.height - b.height || a.s - b.s,
    )
    .map(m => `${m.x},${m.y},${m.width},${m.height},${m.s}`)
    .join("|");
}
