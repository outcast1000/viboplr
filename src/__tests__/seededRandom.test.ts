// The "random" track sort must be a pure function of its seed. It used to call
// Math.random() inside a useMemo, so it re-dealt the order on any recompute (a
// track event, a popularity refresh, StrictMode's second render) rather than only
// when the user asked for a re-roll. These assert the two properties that fix
// depends on: same seed → same order, different seed → different order.
import { describe, it, expect } from "vitest";
import { seededRandom } from "../hooks/useEntityDetail";

/** Mirrors the Fisher-Yates in `useEntityDetail`'s sortedTracks memo. */
function shuffle<T>(items: T[], seed: number): T[] {
  const rand = seededRandom(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const ITEMS = Array.from({ length: 24 }, (_, i) => i);

describe("seededRandom", () => {
  it("is deterministic for a given seed", () => {
    expect(seededRandom(7)()).toBe(seededRandom(7)());
    const a = Array.from({ length: 10 }, seededRandom(42));
    const b = Array.from({ length: 10 }, seededRandom(42));
    expect(a).toEqual(b);
  });

  it("stays in [0, 1)", () => {
    const rand = seededRandom(1);
    for (let i = 0; i < 500; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("gives different sequences for different seeds", () => {
    expect(Array.from({ length: 8 }, seededRandom(1)))
      .not.toEqual(Array.from({ length: 8 }, seededRandom(2)));
  });
});

describe("the seeded shuffle", () => {
  it("returns the same order for the same shuffleKey", () => {
    // This is the bug that was fixed: recomputing the memo must not re-deal.
    expect(shuffle(ITEMS, 3)).toEqual(shuffle(ITEMS, 3));
  });

  it("returns a different order when shuffleKey advances", () => {
    // ...but clicking the random sort again must actually re-roll. Sequential
    // seeds are what `handleSort` produces (`setShuffleKey(k => k + 1)`), so it
    // matters that consecutive seeds differ, not just distant ones.
    expect(shuffle(ITEMS, 3)).not.toEqual(shuffle(ITEMS, 4));
    expect(shuffle(ITEMS, 1)).not.toEqual(shuffle(ITEMS, 2));
  });

  it("is a permutation — no track is dropped or duplicated", () => {
    const out = shuffle(ITEMS, 9);
    expect(out).toHaveLength(ITEMS.length);
    expect([...out].sort((a, b) => a - b)).toEqual(ITEMS);
  });

  it("actually reorders rather than returning the input", () => {
    expect(shuffle(ITEMS, 5)).not.toEqual(ITEMS);
  });
});
