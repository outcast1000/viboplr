// Clip-mode cue sheets: what each element looks like at a given second.
//
// A clip is a cue sheet with `mode: "clip"` — positioned, overlapping,
// animated text / image / shape elements over the whole Now Playing view, a
// text-based video clip an assistant writes for one song. Everything here is
// a pure function of (cue, time), so a frame is fully determined by the
// playback position: seeking, pausing and scrubbing all land on the right
// frame with no animation state to unwind. `CueClipOverlay` calls these from
// its frame loop and writes the result straight into element styles.
//
// Units: positions and offsets are percent of the view (the overlay is a size
// container, so they render as cqw / cqh); text size is percent of the view's
// height. The backend (`cue_sheets.rs`) has already validated every value
// against the same closed vocabularies, so nothing here parses CSS.

import { DEFAULT_CUE_SECS, type Cue, type CueColor, type CueEase, type CueKeyframe } from "./cueSheet";

/** Enter / exit length when the sheet doesn't say. Long enough to read as a
 *  transition, short enough not to eat a four-second cue. */
export const DEFAULT_TRANSITION_SECS = 0.4;
/** How far the slide effects travel, in percent of the view. */
const SLIDE_PCT = 6;

export const DEFAULT_BOX = { x: 10, y: 10, w: 80, h: 80 } as const;
export const DEFAULT_TEXT_SIZE = 5;

/** When a clip element leaves. Unlike a card, it is never cut short by the
 *  next cue — overlapping is the point of a clip. */
export function clipEnd(cue: Cue): number {
  return cue.until ?? cue.at + DEFAULT_CUE_SECS;
}

/** Indices of the elements on screen at `t`, in paint order (layer, then sheet
 *  order). */
export function activeClipCues(cues: Cue[], t: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].at <= t && t < clipEnd(cues[i])) out.push(i);
  }
  return out.sort((a, b) => (cues[a].layer ?? 0) - (cues[b].layer ?? 0) || a - b);
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function ease(kind: CueEase | undefined, p: number): number {
  const x = clamp01(p);
  switch (kind) {
    case "in": return x * x * x;
    case "out": return 1 - (1 - x) ** 3;
    case "in-out": return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    default: return x;
  }
}

function textOf(cue: Cue): string {
  return cue.text ?? "";
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** The enter transition's length. A reveal's default scales with the text, so
 *  a long line types out at a readable pace rather than in a fixed blink. */
export function enterSecs(cue: Cue): number {
  const e = cue.enter;
  if (!e || e.effect === "none") return 0;
  if (e.duration !== undefined) return e.duration;
  if (e.effect === "typewriter") return Math.min(6, Math.max(0.4, textOf(cue).length * 0.045));
  if (e.effect === "words") return Math.min(8, Math.max(0.4, wordCount(textOf(cue)) * 0.28));
  return DEFAULT_TRANSITION_SECS;
}

export function exitSecs(cue: Cue): number {
  const e = cue.exit;
  if (!e || e.effect === "none") return 0;
  return e.duration ?? DEFAULT_TRANSITION_SECS;
}

export interface ClipFrame {
  opacity: number;
  /** Offset from the box, percent of the view. */
  x: number;
  y: number;
  scale: number;
  rotate: number;
  /** px */
  blur: number;
  /** Text reveal: how many characters (typewriter) or words (words) show;
   *  null = all of it. */
  revealChars: number | null;
  revealWords: number | null;
}

type Motion = Pick<ClipFrame, "opacity" | "x" | "y" | "scale" | "blur">;

/** One transition effect at `amount` (1 = fully away, 0 = in place). Enter and
 *  exit share it; `dir` flips the slide so an exit carries on in the same
 *  direction an enter would have arrived from. */
function applyTransition(m: Motion, effect: string, amount: number, dir: 1 | -1): void {
  const a = clamp01(amount);
  if (a === 0) return;
  switch (effect) {
    case "fade": m.opacity *= 1 - a; break;
    case "slide-up": m.y += dir * SLIDE_PCT * a; m.opacity *= 1 - a; break;
    case "slide-down": m.y -= dir * SLIDE_PCT * a; m.opacity *= 1 - a; break;
    case "slide-left": m.x += dir * SLIDE_PCT * a; m.opacity *= 1 - a; break;
    case "slide-right": m.x -= dir * SLIDE_PCT * a; m.opacity *= 1 - a; break;
    case "zoom-in": m.scale *= 1 - 0.15 * a; m.opacity *= 1 - a; break;
    case "zoom-out": m.scale *= 1 + 0.15 * a; m.opacity *= 1 - a; break;
    case "blur": m.blur += 16 * a; m.opacity *= 1 - a; break;
    default: break; // none / reveals: no motion
  }
}

/** Value of one keyframe property at `local` seconds into the cue: held
 *  before the first keyframe that sets it and after the last, interpolated
 *  (with the destination keyframe's easing) in between. */
export function keyframeValue(
  frames: CueKeyframe[] | undefined,
  prop: "x" | "y" | "scale" | "opacity" | "rotate",
  local: number,
  fallback: number,
): number {
  if (!frames || frames.length === 0) return fallback;
  let prev: CueKeyframe | null = null;
  for (const f of frames) {
    const v = f[prop];
    if (v === undefined) continue;
    if (f.t >= local) {
      if (!prev) return v;
      const p = (local - prev.t) / (f.t - prev.t);
      const from = prev[prop] as number;
      return from + (v - from) * ease(f.ease, p);
    }
    prev = f;
  }
  return prev ? (prev[prop] as number) : fallback;
}

/** Everything about one element at playback second `t`. `reducedMotion`
 *  keeps the timing and the fades but drops movement: transitions become
 *  fades, `during` and keyframe motion are skipped. */
export function clipFrame(cue: Cue, t: number, reducedMotion = false): ClipFrame {
  const local = t - cue.at;
  const end = clipEnd(cue);
  const life = end - cue.at;
  const kf = reducedMotion ? undefined : cue.keyframes;
  const m: Motion = {
    opacity: (cue.opacity ?? 1) * keyframeValue(cue.keyframes, "opacity", local, 1),
    x: keyframeValue(kf, "x", local, 0),
    y: keyframeValue(kf, "y", local, 0),
    scale: keyframeValue(kf, "scale", local, 1),
    blur: 0,
  };
  const rotate = keyframeValue(kf, "rotate", local, 0);

  // Continuous motion over the whole life.
  if (!reducedMotion && cue.during && cue.during !== "none") {
    const u = clamp01(life > 0 ? local / life : 1);
    switch (cue.during) {
      case "ken-burns": m.scale *= 1 + 0.1 * u; m.x -= 2 * u; m.y -= 1 * u; break;
      case "drift-up": m.y -= 4 * u; break;
      case "drift-down": m.y += 4 * u; break;
      case "drift-left": m.x -= 4 * u; break;
      case "drift-right": m.x += 4 * u; break;
      case "zoom-slow": m.scale *= 1 + 0.06 * u; break;
      case "pulse": m.scale *= 1 + 0.025 * Math.sin((2 * Math.PI * local) / 1.6); break;
    }
  }

  let revealChars: number | null = null;
  let revealWords: number | null = null;
  const enterLen = enterSecs(cue);
  if (cue.enter && enterLen > 0 && local < enterLen) {
    const p = local / enterLen;
    const effect = cue.enter.effect;
    if (effect === "typewriter") revealChars = Math.ceil(textOf(cue).length * clamp01(p));
    else if (effect === "words") revealWords = Math.ceil(wordCount(textOf(cue)) * clamp01(p));
    else applyTransition(m, reducedMotion ? "fade" : effect, 1 - ease("out", p), 1);
  }
  const exitLen = exitSecs(cue);
  if (cue.exit && exitLen > 0 && local > life - exitLen) {
    const p = (local - (life - exitLen)) / exitLen;
    applyTransition(m, reducedMotion ? "fade" : cue.exit.effect, ease("in", p), -1);
  }

  return { ...m, opacity: clamp01(m.opacity), rotate, revealChars, revealWords };
}

/** How much the view under the clip is darkened at `t`: the strongest `dim`
 *  of the elements on screen, scaled by how far each has faded in, so the
 *  art darkens with its title rather than snapping. */
export function clipDim(cues: Cue[], t: number): number {
  let dim = 0;
  for (const i of activeClipCues(cues, t)) {
    const c = cues[i];
    if (!c.dim) continue;
    dim = Math.max(dim, c.dim * clipFrame({ ...c, opacity: 1, keyframes: undefined }, t, true).opacity);
  }
  return dim;
}

/** A sheet colour as a CSS value. Tokens resolve to the never-flipped
 *  on-artwork variables (the clip paints over art, not a skin surface); a hex
 *  is passed through only if it still looks like one. */
export function cueColorCss(color: CueColor | undefined, fallback: string): string {
  switch (color) {
    case undefined: return fallback;
    case "light": return "var(--hero-text-primary)";
    case "muted": return "var(--hero-text-secondary)";
    case "dark": return "rgb(var(--scrim-rgb))";
    case "accent": return "var(--accent)";
    default: return /^#[0-9a-f]{3}(?:[0-9a-f]{3}(?:[0-9a-f]{2})?)?$/i.test(color) ? color : fallback;
  }
}

/** The CSS transform for a frame. Offsets are in cqw / cqh — percent of the
 *  view, the same unit as the box. */
export function frameTransform(f: ClipFrame): string {
  return `translate(${f.x.toFixed(3)}cqw, ${f.y.toFixed(3)}cqh) scale(${f.scale.toFixed(4)}) rotate(${f.rotate.toFixed(2)}deg)`;
}
