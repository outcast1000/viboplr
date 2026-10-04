import { describe, expect, it } from "vitest";
import {
  activeClipCues, clipDim, clipEnd, clipFrame, cueColorCss, ease, enterSecs, frameTransform, keyframeValue,
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
