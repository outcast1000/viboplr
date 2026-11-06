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

import {
  DEFAULT_CUE_SECS, type Cue, type CueBeats, type CueCamera, type CueColor, type CueEase, type CueKeyframe,
} from "./cueSheet";

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

/** Does this element hide everything under it while it's fully in? An opaque
 *  image or shape whose box covers the whole view. */
export function coversView(cue: Cue): boolean {
  if (cue.kind !== "image" && cue.kind !== "shape") return false;
  if (cue.kind === "image" && (cue.fit === "contain" || !cue.imageUrl)) return false;
  if ((cue.opacity ?? 1) < 1) return false;
  const b = cue.box ?? DEFAULT_BOX;
  return b.x <= 0 && b.y <= 0 && b.x + b.w >= 100 && b.y + b.h >= 100;
}

/** Make picture-to-picture crossfades solid. When a full-view picture fades
 *  out while the next one fades in over it, both are part transparent at once
 *  and the Now Playing view shows through the middle of the cut — the clip
 *  "blinks" to its backdrop. A real crossfade dissolves the new shot over the
 *  old one, which holds. So an outgoing cover whose exit overlaps the entrance
 *  of a cover painted above it keeps full opacity (no exit) until that
 *  entrance has finished, then leaves unseen beneath it. Everything else is
 *  returned untouched (same objects), so a sheet with no such cut is the same
 *  sheet. Pure; run once per sheet. */
export function holdUnderCrossfades(cues: Cue[]): Cue[] {
  let out: Cue[] | null = null;
  for (let i = 0; i < cues.length; i++) {
    const a = cues[i];
    if (!coversView(a)) continue;
    const aEnd = clipEnd(a);
    const exitFrom = aEnd - exitSecs(a);
    let holdTo = -Infinity;
    for (let j = 0; j < cues.length; j++) {
      if (j === i) continue;
      const b = cues[j];
      // Only a picture painted above this one can be what replaces it.
      const above = (b.layer ?? 0) > (a.layer ?? 0) || ((b.layer ?? 0) === (a.layer ?? 0) && j > i);
      if (!above || !coversView(b)) continue;
      const bIn = b.at + enterSecs(b);
      // b arrives while a is still up and is still arriving when a starts to go.
      if (b.at >= a.at && b.at < aEnd && bIn > exitFrom) holdTo = Math.max(holdTo, bIn);
    }
    if (holdTo === -Infinity) continue;
    out ??= cues.slice();
    out[i] = { ...a, until: Math.max(aEnd, holdTo), exit: undefined };
  }
  return out ?? cues;
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

/** Where `t` falls on a tempo grid: `n` = beats since the grid's downbeat
 *  (fractional, negative before it), `beat` its whole part, `phase` 0..1
 *  through the current beat, `barBeat` the beat's place in its bar (0 = the
 *  downbeat). */
export interface BeatPosition {
  n: number;
  beat: number;
  phase: number;
  barBeat: number;
}

export function beatAt(grid: CueBeats, t: number): BeatPosition {
  const n = ((t - grid.offset) * grid.bpm) / 60;
  const beat = Math.floor(n);
  const per = Math.max(1, Math.round(grid.beatsPerBar || 4));
  return { n, beat, phase: n - beat, barBeat: ((beat % per) + per) % per };
}

/** A hit's envelope through one beat: full on the beat, decaying fast — the
 *  shape of a kick drum, which is what an edit "on the beat" follows. */
export function kick(phase: number): number {
  return (1 - clamp01(phase)) ** 4;
}

/** Overshooting ease (0 → 1, peaking a little past 1) for `pop`. */
function backOut(p: number): number {
  const c1 = 2.2;
  const x = clamp01(p) - 1;
  return 1 + (c1 + 1) * x * x * x + c1 * x * x;
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
    case "pop": m.scale *= 1 + 0.25 * a; m.opacity *= 1 - a; break;
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
export function clipFrame(cue: Cue, t: number, reducedMotion = false, beats?: CueBeats): ClipFrame {
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
  let rotate = keyframeValue(kf, "rotate", local, 0);

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
    if (beats) {
      // Locked to the song's clock, not the element's: every element on the
      // beat hits together, whenever it appeared.
      const b = beatAt(beats, t);
      switch (cue.during) {
        case "beat-pulse": m.scale *= 1 + 0.04 * kick(b.phase) * (b.barBeat === 0 ? 1.5 : 1); break;
        case "beat-bounce": m.y -= 1.2 * kick(b.phase); break;
        case "beat-sway": {
          // At an extreme on every beat, swinging the other way on the next.
          const swing = Math.cos(Math.PI * b.n);
          m.x += 1.2 * swing;
          rotate += 1.5 * swing;
          break;
        }
        case "bar-pulse": if (b.barBeat === 0) m.scale *= 1 + 0.07 * kick(b.phase); break;
      }
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
    else if (effect === "pop" && !reducedMotion) {
      // Lands slightly too big and settles: the hit-on-the-beat entrance.
      m.scale *= 0.5 + 0.5 * backOut(p);
      m.opacity *= clamp01(p * 4);
    } else applyTransition(m, reducedMotion ? "fade" : effect, 1 - ease("out", p), 1);
  }
  const exitLen = exitSecs(cue);
  if (cue.exit && exitLen > 0 && local > life - exitLen) {
    const p = (local - (life - exitLen)) / exitLen;
    applyTransition(m, reducedMotion ? "fade" : cue.exit.effect, ease("in", p), -1);
  }

  return { ...m, opacity: clamp01(m.opacity), rotate, revealChars, revealWords };
}

export interface CameraFrame {
  /** Offset, percent of the view. */
  x: number;
  y: number;
  scale: number;
  rotate: number;
}

const STILL: CameraFrame = { x: 0, y: 0, scale: 1, rotate: 0 };

/** How long handheld shake takes to settle in and out. It has no travel of
 *  its own, so it must never switch on or off in one frame. */
export const CAMERA_RAMP_SECS = 0.4;

/** The camera at `t`: every move up at that second, composed (offsets add,
 *  scales multiply), so a push-in can run under handheld shake. Applied to
 *  the picture (`onCameraStage`) about the view's centre.
 *
 *  Every move but pull-out **starts at rest** and travels away from it:
 *  push-in zooms from 1, a pan or tilt slides from 0 with the overscan that
 *  hides the frame's edge growing alongside it. So no move lurches on over a
 *  picture that stays. Pull-out is the mirror (it starts tight and ends at
 *  rest), so it begins on a cut. A travelled move snaps back when it ends,
 *  like a cut: end it where the picture changes, or chain the next move.
 *  Handheld eases in and out over `CAMERA_RAMP_SECS`. Reduced motion: no
 *  camera at all. */
export function cameraFrame(
  camera: CueCamera[] | undefined, t: number, reducedMotion = false, beats?: CueBeats,
): CameraFrame {
  if (reducedMotion || !camera || camera.length === 0) return STILL;
  const f: CameraFrame = { ...STILL };
  for (const mv of camera) {
    if (t < mv.at || t >= mv.until) continue;
    const a = mv.amount ?? 1;
    const u = ease(mv.ease ?? "in-out", (t - mv.at) / (mv.until - mv.at));
    // A pan's overscan grows with its travel: scaling by s about the centre
    // adds (s - 1) * 50% of the view on each side, which covers the 6 * a
    // offset with room to spare.
    const pan = 6 * a * u;
    const overscan = 1 + 0.13 * a * u;
    switch (mv.move) {
      case "push-in": f.scale *= 1 + 0.15 * a * u; break;
      case "pull-out": f.scale *= 1 + 0.15 * a * (1 - u); break;
      // The camera turning left carries the picture right, and so on.
      case "pan-left": f.scale *= overscan; f.x += pan; break;
      case "pan-right": f.scale *= overscan; f.x -= pan; break;
      case "tilt-up": f.scale *= overscan; f.y += pan; break;
      case "tilt-down": f.scale *= overscan; f.y -= pan; break;
      case "handheld": {
        // Sums of incommensurate sines: organic, but still a pure function of
        // t. Everything, overscan included, eases in and out.
        const k = a * ease("in-out", Math.min(1, (t - mv.at) / CAMERA_RAMP_SECS, (mv.until - t) / CAMERA_RAMP_SECS));
        // Overscan covers the sway and the tilt's corners (pinned in cueClip.test).
        f.scale *= 1 + 0.03 * k;
        f.x += 0.6 * k * (Math.sin(t * 1.3) + 0.5 * Math.sin(t * 2.9 + 1));
        f.y += 0.5 * k * (Math.sin(t * 1.7 + 2) + 0.5 * Math.sin(t * 3.7));
        f.rotate += 0.25 * k * Math.sin(t * 0.9 + 0.5);
        break;
      }
      case "beat-punch":
        if (beats) f.scale *= 1 + 0.035 * a * kick(beatAt(beats, t).phase);
        break;
      case "bar-punch": {
        if (!beats) break;
        const b = beatAt(beats, t);
        if (b.barBeat === 0) f.scale *= 1 + 0.07 * a * kick(b.phase);
        break;
      }
    }
  }
  return f;
}

/** The CSS transform for a camera frame (about the stage's centre). */
export function cameraTransform(f: CameraFrame): string {
  return `translate(${f.x.toFixed(3)}cqw, ${f.y.toFixed(3)}cqh) scale(${f.scale.toFixed(4)}) rotate(${f.rotate.toFixed(3)}deg)`;
}

/** Whether an element is part of the picture the camera moves: an image or
 *  shape on layer 0 or below. Text never is — titles, lyrics and panels are
 *  composited over the shot and stay steady, whatever their layer, so an
 *  author who never sets a layer can't have their words shaken. */
export function onCameraStage(cue: Cue): boolean {
  return (cue.kind === "image" || cue.kind === "shape") && (cue.layer ?? 0) <= 0;
}

/** Whether any camera move is running at `t` (reduced motion: never). The
 *  overlay drops the panels' backdrop blur meanwhile: a moving stage under a
 *  `backdrop-filter` re-blurs it every frame, which the motion rules forbid. */
export function cameraMoving(camera: CueCamera[] | undefined, t: number, reducedMotion = false): boolean {
  if (reducedMotion || !camera) return false;
  return camera.some((mv) => t >= mv.at && t < mv.until);
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
