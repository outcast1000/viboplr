import { describe, it, expect } from "vitest";
import { planCells, GUTTER_PX, MIN_SLOT_PX } from "../components/FilmstripSeekBar";
import type { Storyboard } from "../utils/storyboard";

function makeBoard(overrides: Partial<Storyboard> = {}): Storyboard {
  return {
    sheets: ["sheet.jpg"],
    cols: 10,
    rows: 10,
    count: 100,
    tileW: 200,
    tileH: 112,
    startSecs: 0,
    intervalSecs: 10,
    ...overrides,
  };
}

// A realistic now-playing strip: 34px bar, 5px rails, so 24px of frame.
const H = 32;
const FRAME_H = 22;

/** The width the frames themselves get: the track minus every gutter between them. */
function frameBudget(width: number, n: number): number {
  return width - GUTTER_PX * (n - 1);
}

describe("planCells", () => {
  it("lays cells at integer widths that sum back to the track width minus the gutters", () => {
    // 1000 isn't divisible by the cell count, so this is the accumulating-gap case.
    const cells = planCells(makeBoard(), 1000, H, FRAME_H, 1000);
    expect(cells.length).toBeGreaterThan(1);
    expect(cells.every(c => Number.isInteger(c.width))).toBe(true);
    expect(cells.reduce((sum, c) => sum + c.width, 0)).toBe(frameBudget(1000, cells.length));
  });

  it("never slices finer than the tile count, so no frame repeats", () => {
    // A short clip: 8 tiles, but the width would otherwise fit more cells.
    const board = makeBoard({ count: 8, intervalSecs: 10 });
    const cells = planCells(board, 1000, H, FRAME_H, 80);
    expect(cells).toHaveLength(8);
    expect(cells.reduce((sum, c) => sum + c.width, 0)).toBe(frameBudget(1000, 8));
  });

  it("leaves a blank cell where the storyboard does not reach", () => {
    // Board covers 100s; the track runs 200s, so the back half has no tiles.
    const board = makeBoard({ count: 10, intervalSecs: 10 });
    const cells = planCells(board, 400, H, FRAME_H, 200);
    expect(cells.some(c => c.style === null)).toBe(true);
    // Everything in the covered first half resolves to a real tile.
    expect(cells.filter(c => c.mid < 0.5).every(c => c.style !== null)).toBe(true);
    // And nothing past coverage silently repeats the last frame.
    expect(cells.filter(c => c.mid > 0.5).every(c => c.style === null)).toBe(true);
  });

  it("holds the slot floor at both real bar heights, so frames stay big enough to read", () => {
    // The floor — not the 16:9 ratio — is what sizes a frame at the heights the bar
    // actually renders at: a 16:9 slot against a 22px frame area is only ~39px, and
    // frames that small ran together no matter how they were separated.
    for (const frameH of [FRAME_H, 20 /* the 28px fullscreen bar */]) {
      const cells = planCells(makeBoard(), 1000, H, frameH, 1000);
      const avg = frameBudget(1000, cells.length) / cells.length;
      expect(avg).toBeGreaterThanOrEqual(MIN_SLOT_PX - GUTTER_PX);
      expect(avg).toBeLessThan(MIN_SLOT_PX + GUTTER_PX * 2);
    }
  });

  it("widens the slot past the floor when the frame area is tall enough to earn it", () => {
    // A tall strip: 16:9 against a 90px frame area is 161px, which beats the floor.
    const cells = planCells(makeBoard(), 1000, 100, 90, 1000);
    const avg = frameBudget(1000, cells.length) / cells.length;
    expect(avg).toBeGreaterThan(MIN_SLOT_PX);
  });

  it("keeps every frame at least a pixel wide when gutters would eat the track", () => {
    // A sliver of a track: the gutters alone could out-budget the frames.
    for (const width of [1, 2, 5, 9, 20]) {
      const cells = planCells(makeBoard(), width, H, FRAME_H, 1000);
      expect(cells.length).toBeGreaterThanOrEqual(1);
      expect(cells.every(c => c.width >= 1)).toBe(true);
      expect(cells.reduce((sum, c) => sum + c.width, 0)).toBe(frameBudget(width, cells.length));
    }
  });

  it("returns nothing for a degenerate box or an unknown duration", () => {
    expect(planCells(makeBoard(), 0, H, FRAME_H, 1000)).toEqual([]);
    expect(planCells(makeBoard(), 1000, H, 0, 1000)).toEqual([]);
    expect(planCells(makeBoard(), 1000, H, FRAME_H, 0)).toEqual([]);
  });
});
