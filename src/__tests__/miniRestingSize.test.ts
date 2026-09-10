import { describe, it, expect } from "vitest";
import {
  cycleRestingSize, isAlwaysExpanded, MINI_RESTING_SIZES, MINI_RESTING_SIZE_LABELS,
  type MiniRestingSize,
} from "../hooks/useMiniMode";

describe("cycleRestingSize", () => {
  it("returns compact when current is normal", () => {
    expect(cycleRestingSize("normal")).toBe("compact");
  });

  it("returns full when current is compact", () => {
    expect(cycleRestingSize("compact")).toBe("full");
  });

  it("returns normal when current is full", () => {
    expect(cycleRestingSize("full")).toBe("normal");
  });

  it("visits every size and comes back round", () => {
    const seen: MiniRestingSize[] = [];
    let size: MiniRestingSize = "normal";
    for (let i = 0; i < MINI_RESTING_SIZES.length; i++) {
      seen.push(size);
      size = cycleRestingSize(size);
    }
    expect(new Set(seen)).toEqual(new Set(MINI_RESTING_SIZES));
    expect(size).toBe("normal");
  });
});

describe("isAlwaysExpanded", () => {
  // Only "full" rests at the hover-expanded height, so only it suppresses
  // hover expand/collapse (see useMiniMode.ts).
  it("is true for full only", () => {
    expect(isAlwaysExpanded("full")).toBe(true);
    expect(isAlwaysExpanded("normal")).toBe(false);
    expect(isAlwaysExpanded("compact")).toBe(false);
  });
});

describe("MINI_RESTING_SIZE_LABELS", () => {
  it("labels every size", () => {
    for (const size of MINI_RESTING_SIZES) {
      expect(MINI_RESTING_SIZE_LABELS[size]).toBeTruthy();
    }
  });
});
