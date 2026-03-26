import { describe, it, expect } from "vitest";
import { isPositionOnScreen, clampToNearestMonitor } from "../hooks/useMiniMode";

// --- Extracted pure functions from hooks ---

// From useAutoContinue.ts: weighted strategy picker
type AutoContinueWeights = {
  random: number;
  sameArtist: number;
  sameTag: number;
  mostPlayed: number;
  liked: number;
};

const STRATEGY_KEYS: (keyof AutoContinueWeights)[] = [
  "random", "sameArtist", "sameTag", "mostPlayed", "liked",
];

const STRATEGY_MAP: Record<keyof AutoContinueWeights, string> = {
  random: "random",
  sameArtist: "same_artist",
  sameTag: "same_tag",
  mostPlayed: "most_played",
  liked: "liked",
};

function pickStrategy(weights: AutoContinueWeights, roll: number): string {
  let cumulative = 0;
  for (const key of STRATEGY_KEYS) {
    cumulative += weights[key];
    if (roll < cumulative) return STRATEGY_MAP[key];
  }
  return "random";
}

// From useQueue.ts: generateShuffleOrder
function generateShuffleOrder(length: number, startIndex: number): number[] {
  const indices = Array.from({ length }, (_, i) => i).filter(i => i !== startIndex);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return [startIndex, ...indices];
}

describe("pickStrategy (weighted random)", () => {
  const weights: AutoContinueWeights = {
    random: 40, sameArtist: 20, sameTag: 20, mostPlayed: 10, liked: 10,
  };

  it("picks random for roll 0-39", () => {
    expect(pickStrategy(weights, 0)).toBe("random");
    expect(pickStrategy(weights, 39)).toBe("random");
  });

  it("picks same_artist for roll 40-59", () => {
    expect(pickStrategy(weights, 40)).toBe("same_artist");
    expect(pickStrategy(weights, 59)).toBe("same_artist");
  });

  it("picks same_tag for roll 60-79", () => {
    expect(pickStrategy(weights, 60)).toBe("same_tag");
    expect(pickStrategy(weights, 79)).toBe("same_tag");
  });

  it("picks most_played for roll 80-89", () => {
    expect(pickStrategy(weights, 80)).toBe("most_played");
    expect(pickStrategy(weights, 89)).toBe("most_played");
  });

  it("picks liked for roll 90-99", () => {
    expect(pickStrategy(weights, 90)).toBe("liked");
    expect(pickStrategy(weights, 99)).toBe("liked");
  });

  it("falls back to random for out-of-range roll", () => {
    expect(pickStrategy(weights, 100)).toBe("random");
  });

  it("handles all-zero weights by falling back to random", () => {
    const zero = { random: 0, sameArtist: 0, sameTag: 0, mostPlayed: 0, liked: 0 };
    expect(pickStrategy(zero, 0)).toBe("random");
  });

  it("handles single-strategy weight", () => {
    const single = { random: 0, sameArtist: 100, sameTag: 0, mostPlayed: 0, liked: 0 };
    expect(pickStrategy(single, 50)).toBe("same_artist");
  });
});

describe("generateShuffleOrder", () => {
  it("starts with startIndex", () => {
    const order = generateShuffleOrder(5, 2);
    expect(order[0]).toBe(2);
  });

  it("includes all indices exactly once", () => {
    const order = generateShuffleOrder(5, 0);
    expect(order.length).toBe(5);
    expect([...order].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("works with single element", () => {
    const order = generateShuffleOrder(1, 0);
    expect(order).toEqual([0]);
  });

  it("works with startIndex at end", () => {
    const order = generateShuffleOrder(3, 2);
    expect(order[0]).toBe(2);
    expect(order.length).toBe(3);
    expect([...order].sort()).toEqual([0, 1, 2]);
  });
});

const singleMonitor = [{ x: 0, y: 0, w: 1920, h: 1080 }];
const dualMonitors = [
  { x: 0, y: 0, w: 1920, h: 1080 },
  { x: 1920, y: 0, w: 2560, h: 1440 },
];

describe("isPositionOnScreen", () => {
  it("returns true when point is within a monitor", () => {
    expect(isPositionOnScreen(100, 100, singleMonitor)).toBe(true);
  });

  it("returns false when point is outside all monitors", () => {
    expect(isPositionOnScreen(3000, 500, singleMonitor)).toBe(false);
  });

  it("returns true for top-left edge (inclusive)", () => {
    expect(isPositionOnScreen(0, 0, singleMonitor)).toBe(true);
  });

  it("returns false for right/bottom edge (exclusive)", () => {
    expect(isPositionOnScreen(1920, 1080, singleMonitor)).toBe(false);
  });

  it("returns true for point on second monitor", () => {
    expect(isPositionOnScreen(2000, 500, dualMonitors)).toBe(true);
  });

  it("returns true for negative coordinates on a monitor", () => {
    const leftMonitor = [{ x: -1920, y: 0, w: 1920, h: 1080 }];
    expect(isPositionOnScreen(-500, 500, leftMonitor)).toBe(true);
  });

  it("returns true when monitors array is empty (graceful fallback)", () => {
    expect(isPositionOnScreen(9999, 9999, [])).toBe(true);
  });
});

describe("clampToNearestMonitor", () => {
  it("returns unchanged position when already on-screen", () => {
    expect(clampToNearestMonitor(100, 100, 500, 40, singleMonitor)).toEqual({ x: 100, y: 100 });
  });

  it("clamps position off-screen to the right", () => {
    const result = clampToNearestMonitor(2000, 500, 500, 40, singleMonitor);
    expect(result.x).toBe(1420); // 1920 - 500
    expect(result.y).toBe(500);
  });

  it("clamps position off-screen above", () => {
    const result = clampToNearestMonitor(100, -200, 500, 40, singleMonitor);
    expect(result.x).toBe(100);
    expect(result.y).toBe(0);
  });

  it("snaps to nearest monitor in dual setup", () => {
    // Point closer to second monitor
    const result = clampToNearestMonitor(5000, 500, 500, 40, dualMonitors);
    expect(result.x).toBe(3980); // 1920 + 2560 - 500
    expect(result.y).toBe(500);
  });

  it("returns original coordinates when monitors is empty", () => {
    expect(clampToNearestMonitor(9999, 9999, 500, 40, [])).toEqual({ x: 9999, y: 9999 });
  });
});
