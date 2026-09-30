import { describe, it, expect } from "vitest";
import { allocateSlotsBalanced } from "../utils/searchSlots";

describe("allocateSlotsBalanced", () => {
  it("caps at 7 total with the original min floors (2/2/3)", () => {
    expect(allocateSlotsBalanced(5, 1, 10)).toEqual({ artists: 2, albums: 1, tracks: 4 });
  });

  it("never exceeds available counts", () => {
    const s = allocateSlotsBalanced(1, 0, 2);
    expect(s).toEqual({ artists: 1, albums: 0, tracks: 2 });
  });

  it("distributes leftover slots to the fuller categories", () => {
    const s = allocateSlotsBalanced(10, 10, 10);
    expect(s.artists + s.albums + s.tracks).toBe(7);
  });
});
