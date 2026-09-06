import { describe, it, expect } from "vitest";
import { computeReorderedIds } from "../utils/playlistReorder";

describe("computeReorderedIds", () => {
  const IDS = [10, 20, 30, 40, 50];

  it("moves one row down (insertAt counted in the original array)", () => {
    // Drop 20 before the row currently at index 4 (50).
    expect(computeReorderedIds(IDS, [20], 4)).toEqual([10, 30, 40, 20, 50]);
  });

  it("moves one row up", () => {
    expect(computeReorderedIds(IDS, [40], 1)).toEqual([10, 40, 20, 30, 50]);
  });

  it("moves to the very end (insertAt = length)", () => {
    expect(computeReorderedIds(IDS, [10], 5)).toEqual([20, 30, 40, 50, 10]);
  });

  it("moves a non-contiguous multi-selection as a block, keeping its relative order", () => {
    expect(computeReorderedIds(IDS, [10, 40], 3)).toEqual([20, 30, 10, 40, 50]);
  });

  it("keeps the selection's stored order even when movedIds arrive shuffled", () => {
    expect(computeReorderedIds(IDS, [40, 10], 3)).toEqual([20, 30, 10, 40, 50]);
  });

  it("returns the input reference for a no-op move (drop onto itself)", () => {
    expect(computeReorderedIds(IDS, [30], 2)).toBe(IDS);
    expect(computeReorderedIds(IDS, [30], 3)).toBe(IDS);
    expect(computeReorderedIds(IDS, [], 0)).toBe(IDS);
  });

  it("clamps an out-of-range insertAt", () => {
    expect(computeReorderedIds(IDS, [50], 99)).toBe(IDS);
    expect(computeReorderedIds(IDS, [50], -1)).toEqual([50, 10, 20, 30, 40]);
  });
});
