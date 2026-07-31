import { describe, it, expect } from "vitest";
import { planCells } from "../components/FilmstripSeekBar";
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

describe("planCells", () => {
  it("lays cells at integer widths that sum back to the exact track width", () => {
    // 1000 isn't divisible by the cell count, so this is the accumulating-gap case.
    const cells = planCells(makeBoard(), 1000, H, FRAME_H, 1000);
    expect(cells.length).toBeGreaterThan(1);
    expect(cells.every(c => Number.isInteger(c.width))).toBe(true);
    expect(cells.reduce((sum, c) => sum + c.width, 0)).toBe(1000);
  });

  it("never slices finer than the tile count, so no frame repeats", () => {
    // A short clip: 8 tiles, but the width would otherwise fit ~25 cells.
    const board = makeBoard({ count: 8, intervalSecs: 10 });
    const cells = planCells(board, 1000, H, FRAME_H, 80);
    expect(cells).toHaveLength(8);
    expect(cells.reduce((sum, c) => sum + c.width, 0)).toBe(1000);
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

  it("keeps slots at 16:9 against the frame area, not the full bar height", () => {
    const cells = planCells(makeBoard(), 1000, H, FRAME_H, 1000);
    // frameH 22 * (200/112) ≈ 39px slots → ~26 cells across 1000px.
    const avg = 1000 / cells.length;
    expect(avg).toBeGreaterThan(30);
    expect(avg).toBeLessThan(50);
  });

  it("returns nothing for a degenerate box or an unknown duration", () => {
    expect(planCells(makeBoard(), 0, H, FRAME_H, 1000)).toEqual([]);
    expect(planCells(makeBoard(), 1000, H, 0, 1000)).toEqual([]);
    expect(planCells(makeBoard(), 1000, H, FRAME_H, 0)).toEqual([]);
  });
});
