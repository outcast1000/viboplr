import { describe, it, expect } from "vitest";
import { rememberShownSeeds, coerceSeedCooldown, RADIO_SEED_COOLDOWN_REFRESHES } from "../utils/radioSeedCooldown";

describe("rememberShownSeeds", () => {
  it("appends the shown seeds, oldest first", () => {
    expect(rememberShownSeeds([1, 2], [3, 4], 2, 3)).toEqual([1, 2, 3, 4]);
  });

  it("trims to refreshes × perRefresh, dropping the oldest", () => {
    // capacity 2 × 2 = 4
    expect(rememberShownSeeds([1, 2, 3, 4], [5, 6], 2, 2)).toEqual([3, 4, 5, 6]);
  });

  it("moves a re-shown seed to the newest end instead of duplicating it", () => {
    // 2 came back via the small-library top-up: it must not be listed twice,
    // and it must count as freshly shown.
    expect(rememberShownSeeds([1, 2, 3], [2, 4], 7, 3)).toEqual([1, 3, 2, 4]);
  });

  it("defaults to RADIO_SEED_COOLDOWN_REFRESHES refreshes", () => {
    const per = 7;
    let ring: number[] = [];
    for (let r = 0; r < RADIO_SEED_COOLDOWN_REFRESHES + 2; r++) {
      const shown = Array.from({ length: per }, (_, i) => r * 100 + i);
      ring = rememberShownSeeds(ring, shown, per);
    }
    expect(ring).toHaveLength(per * RADIO_SEED_COOLDOWN_REFRESHES);
    // The two oldest refreshes (r = 0, 1) have aged out.
    expect(ring.some((id) => id < 200)).toBe(false);
  });

  it("drops non-finite ids and returns [] for a zero capacity", () => {
    expect(rememberShownSeeds([NaN, 1], [2, Infinity], 5, 2)).toEqual([1, 2]);
    expect(rememberShownSeeds([1, 2], [3], 0, 3)).toEqual([]);
  });
});

describe("coerceSeedCooldown", () => {
  it("reads a well-formed ring", () => {
    expect(coerceSeedCooldown([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("treats anything malformed as empty and filters bad entries", () => {
    expect(coerceSeedCooldown(undefined)).toEqual([]);
    expect(coerceSeedCooldown("nope")).toEqual([]);
    expect(coerceSeedCooldown({ a: 1 })).toEqual([]);
    expect(coerceSeedCooldown([1, "2", null, NaN, 3])).toEqual([1, 3]);
  });
});
