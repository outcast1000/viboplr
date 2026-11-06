import { describe, expect, it } from "vitest";
import {
  activeClipCues, beatAt, cameraFrame, cameraTransform, clipDim, clipEnd, clipFrame, cueColorCss, ease, enterSecs,
  frameTransform, keyframeValue, kick, onCameraStage, cameraMoving, coversView, holdUnderCrossfades,
} from "../utils/cueClip";
import type { Cue } from "../utils/cueSheet";

const el = (over: Partial<Cue>): Cue => ({ at: 10, until: 20, kind: "text", text: "hello world again", ...over });

describe("clip timing", () => {
  it("elements overlap — the next cue never cuts one short", () => {
    const cues = [el({ at: 0, until: 30 }), el({ at: 5, until: 8 })];
    expect(activeClipCues(cues, 6)).toEqual([0, 1]);
    expect(activeClipCues(cues, 9)).toEqual([0]);
    expect(clipEnd(el({ until: undefined }))).toBe(20); // at 10 + default 10s
  });

  it("paints in layer order, then sheet order", () => {
    const cues = [el({ layer: 2 }), el({}), el({ layer: -1 }), el({})];
    expect(activeClipCues(cues, 12)).toEqual([2, 1, 3, 0]);
  });
});

describe("clipFrame", () => {
  it("is at rest between its transitions", () => {
    const f = clipFrame(el({ enter: { effect: "fade" }, exit: { effect: "fade" } }), 15);
    expect(f).toMatchObject({ opacity: 1, x: 0, y: 0, scale: 1, rotate: 0, blur: 0, revealChars: null });
  });

  it("fades and slides in from where the effect names, and keeps going on exit", () => {
    const cue = el({ enter: { effect: "slide-up", duration: 1 }, exit: { effect: "slide-up", duration: 1 } });
    const entering = clipFrame(cue, 10.25);
    expect(entering.opacity).toBeGreaterThan(0);
    expect(entering.opacity).toBeLessThan(1);
    expect(entering.y).toBeGreaterThan(0); // below its spot, rising
    const leaving = clipFrame(cue, 19.5);
    expect(leaving.y).toBeLessThan(0); // carries on upwards
    expect(clipFrame(cue, 10).opacity).toBe(0);
  });

  it("types a typewriter line out at a pace set by its length", () => {
    const cue = el({ text: "abcdefghij", enter: { effect: "typewriter", duration: 2 } });
    expect(clipFrame(cue, 10).revealChars).toBe(0);
    expect(clipFrame(cue, 11).revealChars).toBe(5);
    expect(clipFrame(cue, 12.5).revealChars).toBeNull();
    expect(clipFrame(cue, 11).opacity).toBe(1); // a reveal doesn't also fade
    expect(enterSecs(el({ text: "x".repeat(40), enter: { effect: "typewriter" } }))).toBeCloseTo(1.8);
  });

  it("reveals word by word", () => {
    const cue = el({ text: "one two three four", enter: { effect: "words", duration: 4 } });
    expect(clipFrame(cue, 11.5).revealWords).toBe(2);
  });

  it("follows keyframes, easing into each and holding outside them", () => {
    const frames = [{ t: 2, x: 0 }, { t: 4, x: 20, ease: "linear" as const }, { t: 6, scale: 2 }];
    expect(keyframeValue(frames, "x", 0, 0)).toBe(0);
    expect(keyframeValue(frames, "x", 3, 0)).toBe(10);
    expect(keyframeValue(frames, "x", 9, 0)).toBe(20);
    expect(keyframeValue(frames, "scale", 1, 1)).toBe(2); // only one frame sets it: held
    expect(keyframeValue(undefined, "rotate", 1, 0)).toBe(0);
    expect(clipFrame(el({ keyframes: frames }), 13).x).toBe(10);
  });

  it("drifts over its life", () => {
    const f = clipFrame(el({ during: "drift-up" }), 20 - 0.0001);
    expect(f.y).toBeCloseTo(-4, 2);
  });

  it("under reduced motion keeps timing and fades but drops movement", () => {
    const cue = el({
      enter: { effect: "slide-left", duration: 1 }, during: "ken-burns", keyframes: [{ t: 0, x: 30 }],
    });
    const f = clipFrame(cue, 10.5, true);
    expect(f.x).toBe(0);
    expect(f.scale).toBe(1);
    expect(f.opacity).toBeGreaterThan(0);
    expect(f.opacity).toBeLessThan(1);
  });
});

describe("clip helpers", () => {
  it("dims with the strongest element on screen, fading with it", () => {
    const cues = [el({ dim: 0.6, enter: { effect: "fade", duration: 2 } }), el({ dim: 0.3 })];
    expect(clipDim(cues, 15)).toBeCloseTo(0.6);
    expect(clipDim(cues, 10.2)).toBeCloseTo(0.3); // the 0.6 one is still mostly faded out
    expect(clipDim(cues, 25)).toBe(0);
  });

  it("maps colours to on-artwork tokens, and passes only real hex through", () => {
    expect(cueColorCss("light", "x")).toBe("var(--hero-text-primary)");
    expect(cueColorCss("dark", "x")).toBe("rgb(var(--scrim-rgb))");
    expect(cueColorCss("#ffcc0080", "x")).toBe("#ffcc0080");
    expect(cueColorCss("#ffcc0;" as never, "fallback")).toBe("fallback");
    expect(cueColorCss(undefined, "fallback")).toBe("fallback");
  });

  it("eases and builds a transform in view units", () => {
    expect(ease("out", 0.5)).toBeCloseTo(0.875);
    expect(ease("in", 2)).toBe(1);
    expect(frameTransform({ opacity: 1, x: 5, y: -2, scale: 1.1, rotate: 3, blur: 0, revealChars: null, revealWords: null }))
      .toBe("translate(5.000cqw, -2.000cqh) scale(1.1000) rotate(3.00deg)");
  });
});

describe("tempo grid and beat motion", () => {
  const grid = { bpm: 120, offset: 2, beatsPerBar: 4 }; // a beat every 0.5s, downbeat at 2s

  it("places a time on the grid, before the downbeat too", () => {
    expect(beatAt(grid, 2)).toEqual({ n: 0, beat: 0, phase: 0, barBeat: 0 });
    expect(beatAt(grid, 3.25)).toMatchObject({ beat: 2, phase: 0.5, barBeat: 2 });
    expect(beatAt(grid, 4)).toMatchObject({ beat: 4, barBeat: 0 });
    expect(beatAt(grid, 1.5)).toMatchObject({ beat: -1, barBeat: 3 });
  });

  it("kicks on the beat and decays through it", () => {
    expect(kick(0)).toBe(1);
    expect(kick(0.5)).toBeCloseTo(0.0625);
    expect(kick(1)).toBe(0);
  });

  it("beat-pulse hits on the song's clock, harder on the downbeat", () => {
    const cue = el({ at: 0, until: 60, during: "beat-pulse" });
    const downbeat = clipFrame(cue, 4, false, grid).scale;
    const offbeat = clipFrame(cue, 4.5, false, grid).scale;
    const between = clipFrame(cue, 4.75, false, grid).scale;
    expect(downbeat).toBeGreaterThan(offbeat);
    expect(offbeat).toBeGreaterThan(between);
    // Two elements that appeared at different times hit together.
    expect(clipFrame(el({ at: 3.1, until: 60, during: "beat-pulse" }), 4, false, grid).scale).toBeCloseTo(downbeat);
  });

  it("bar-pulse only moves on downbeats; beat-sway swings one way per beat", () => {
    const bar = el({ at: 0, until: 60, during: "bar-pulse" });
    expect(clipFrame(bar, 4, false, grid).scale).toBeGreaterThan(1);
    expect(clipFrame(bar, 4.5, false, grid).scale).toBe(1);
    const sway = el({ at: 0, until: 60, during: "beat-sway" });
    expect(clipFrame(sway, 4, false, grid).x).toBeCloseTo(1.2);
    expect(clipFrame(sway, 4.5, false, grid).x).toBeCloseTo(-1.2);
  });

  it("drops beat motion under reduced motion and without a grid", () => {
    const cue = el({ at: 0, until: 60, during: "beat-bounce" });
    expect(clipFrame(cue, 4, false, grid).y).toBeLessThan(0);
    expect(clipFrame(cue, 4, true, grid).y).toBe(0);
    expect(clipFrame(cue, 4).y).toBe(0);
  });

  it("pop lands a little too big and settles", () => {
    const cue = el({ at: 10, until: 20, enter: { effect: "pop", duration: 0.4 } });
    const scales = [0.05, 0.2, 0.3, 0.4].map((d) => clipFrame(cue, 10 + d).scale);
    expect(scales[0]).toBeLessThan(1);
    expect(Math.max(...scales)).toBeGreaterThan(1);
    expect(clipFrame(cue, 10.5).scale).toBe(1);
    expect(clipFrame(cue, 10.2, true).scale).toBe(1); // reduced motion: a fade
  });
});

describe("camera", () => {
  const grid = { bpm: 120, offset: 0, beatsPerBar: 4 };
  const REST = { x: 0, y: 0, scale: 1, rotate: 0 };

  it("is still outside its moves and under reduced motion", () => {
    const cam = [{ at: 10, until: 20, move: "push-in" as const }];
    expect(cameraFrame(cam, 5)).toEqual(REST);
    expect(cameraFrame(cam, 15, true).scale).toBe(1);
    expect(cameraFrame(undefined, 15).scale).toBe(1);
  });

  it("pushes in and pulls out across a move, scaled by amount", () => {
    const push = [{ at: 0, until: 20, move: "push-in" as const, ease: "linear" as const }];
    expect(cameraFrame(push, 5).scale).toBeCloseTo(1.0375);
    expect(cameraFrame(push, 15).scale).toBeCloseTo(1.1125);
    expect(cameraFrame([{ ...push[0], amount: 2 }], 15).scale).toBeCloseTo(1.225);
    const pull = [{ at: 0, until: 20, move: "pull-out" as const, ease: "linear" as const }];
    expect(cameraFrame(pull, 5).scale).toBeCloseTo(1.1125);
    expect(cameraFrame(pull, 20)).toEqual(REST);
  });

  it("never lurches on: every move but pull-out starts at rest, and handheld ends at rest", () => {
    for (const move of ["push-in", "pan-left", "pan-right", "tilt-up", "tilt-down", "handheld"] as const) {
      const cam = [{ at: 10, until: 20, move, amount: 3 }];
      const start = cameraFrame(cam, 10);
      expect(start.scale, move).toBeCloseTo(1, 4);
      expect(start.x, move).toBeCloseTo(0, 4);
      expect(start.y, move).toBeCloseTo(0, 4);
      const mid = cameraFrame(cam, 15);
      expect(Math.abs(mid.scale - 1) + Math.abs(mid.x) + Math.abs(mid.y), move).toBeGreaterThan(0.01);
    }
    const hh = cameraFrame([{ at: 10, until: 20, move: "handheld", amount: 3 }], 19.9999);
    expect(hh.scale).toBeCloseTo(1, 4);
    expect(hh.x).toBeCloseTo(0, 3);
  });

  it("pans travel from rest, with overscan that always hides the frame edge", () => {
    const pan = { at: 0, until: 10, move: "pan-left" as const, ease: "linear" as const };
    expect(cameraFrame([pan], 5).x).toBeCloseTo(3);
    expect(cameraFrame([pan], 9.999).x).toBeCloseTo(6, 2);
    for (const amount of [0.5, 1, 3]) {
      for (const t of [1, 5, 9.99]) {
        const f = cameraFrame([{ ...pan, amount }], t);
        expect((f.scale - 1) * 50).toBeGreaterThanOrEqual(Math.abs(f.x)); // edge margin, percent of the view
      }
    }
    const both = cameraFrame([pan, { at: 0, until: 10, move: "push-in", ease: "linear" }], 5);
    expect(both.scale).toBeCloseTo(1.065 * 1.075);
  });

  it("punches on the grid", () => {
    const beat = [{ at: 0, until: 60, move: "beat-punch" as const }];
    expect(cameraFrame(beat, 4.5, false, grid).scale).toBeGreaterThan(cameraFrame(beat, 4.75, false, grid).scale);
    const bar = [{ at: 0, until: 60, move: "bar-punch" as const }];
    expect(cameraFrame(bar, 4, false, grid).scale).toBeCloseTo(1.07);
    expect(cameraFrame(bar, 4.5, false, grid).scale).toBe(1);
    expect(cameraFrame(bar, 4).scale).toBe(1); // no grid: nothing to hit on
  });

  it("knows when it is moving, for the panels' blur", () => {
    const cam = [{ at: 10, until: 20, move: "handheld" as const }];
    expect(cameraMoving(cam, 15)).toBe(true);
    expect(cameraMoving(cam, 20)).toBe(false);
    expect(cameraMoving(cam, 15, true)).toBe(false);
    expect(cameraMoving(undefined, 15)).toBe(false);
  });

  it("moves images and shapes on layer ≤ 0; text of any layer stays composited", () => {
    expect(onCameraStage(el({ kind: "image", imageUrl: "https://x/y.jpg" }))).toBe(true);
    expect(onCameraStage(el({ kind: "shape", layer: -5 }))).toBe(true);
    expect(onCameraStage(el({ kind: "image", imageUrl: "https://x/y.jpg", layer: 2 }))).toBe(false);
    expect(onCameraStage(el({}))).toBe(false); // an unlayered title
    expect(onCameraStage(el({ kind: "quote", layer: -3 }))).toBe(false);
    expect(cameraTransform({ x: 1, y: -2, scale: 1.1, rotate: 0.5 })).toBe(
      "translate(1.000cqw, -2.000cqh) scale(1.1000) rotate(0.500deg)",
    );
  });
});

describe("holdUnderCrossfades", () => {
  const FULL = { x: 0, y: 0, w: 100, h: 100 };
  const shot = (at: number, until: number, over: Partial<Cue> = {}): Cue => ({
    at, until, kind: "image", imageUrl: `https://x/${at}.jpg`, box: FULL, fit: "cover",
    enter: { effect: "fade", duration: 1 }, exit: { effect: "fade", duration: 1 }, ...over,
  });

  it("knows a full-view picture from one that lets the view through", () => {
    expect(coversView(shot(0, 5))).toBe(true);
    expect(coversView(shot(0, 5, { fit: "contain" }))).toBe(false);
    expect(coversView(shot(0, 5, { opacity: 0.8 }))).toBe(false);
    expect(coversView(shot(0, 5, { box: { x: 10, y: 0, w: 90, h: 100 } }))).toBe(false);
    expect(coversView({ at: 0, kind: "shape", box: FULL })).toBe(true);
    expect(coversView({ at: 0, kind: "text", text: "x", box: FULL })).toBe(false);
  });

  it("holds the outgoing shot opaque until the next one has dissolved in", () => {
    // a fades out over 9–10 while b fades in over 9–10: the midpoint was ~25% see-through.
    const [a, b] = holdUnderCrossfades([shot(0, 10), shot(9, 20)]);
    expect(a.exit).toBeUndefined();
    expect(a.until).toBe(10); // b is fully in at 10
    expect(clipFrame(a, 9.5).opacity).toBe(1);
    expect(b).toEqual(shot(9, 20)); // the incoming shot is untouched
  });

  it("extends a shot that would have left before its replacement finished arriving", () => {
    const [a] = holdUnderCrossfades([shot(0, 10), shot(9.8, 20, { enter: { effect: "fade", duration: 2 } })]);
    expect(a.until).toBe(11.8);
  });

  it("leaves real gaps, pictures painted underneath, and plain sheets alone", () => {
    const gap = [shot(0, 10), shot(12, 20)];
    expect(holdUnderCrossfades(gap)).toBe(gap);
    const under = [shot(0, 10, { layer: 2 }), shot(9, 20, { layer: -5 })];
    expect(holdUnderCrossfades(under)).toBe(under);
    const text = [el({})];
    expect(holdUnderCrossfades(text)).toBe(text);
  });
});

describe("handheld overscan", () => {
  it("covers its own sway and tilt at every instant, so the frame's edge never shows", () => {
    // Aspect up to 2.4:1. For each sampled frame, the scaled, rotated picture must still contain the view.
    const aspect = 2.4;
    for (let t = 10.5; t < 19.5; t += 0.05) {
      const f = cameraFrame([{ at: 10, until: 20, move: "handheld", amount: 1.2 }], t);
      const r = (Math.abs(f.rotate) * Math.PI) / 180;
      // Half-extents of the view, in units of view height, after undoing the offset.
      const hw = aspect / 2 + Math.abs(f.x) / 100 * aspect;
      const hh = 0.5 + Math.abs(f.y) / 100;
      // A rotated rectangle of half-size (s*aspect/2, s/2) contains the box when both projections fit.
      expect(hw * Math.cos(r) + hh * Math.sin(r)).toBeLessThanOrEqual((f.scale * aspect) / 2 + 1e-9);
      expect(hw * Math.sin(r) + hh * Math.cos(r)).toBeLessThanOrEqual(f.scale / 2 + 1e-9);
    }
  });
});
