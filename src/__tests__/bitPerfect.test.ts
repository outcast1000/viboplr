import { describe, it, expect } from "vitest";
import { bitPerfectBlockers, isBitPerfect } from "../utils/bitPerfect";

const clean = { exclusive: true, eqEnabled: false, rgMode: "off" as const, volume: 1.0 };

describe("bitPerfect", () => {
  it("is bit-perfect with exclusive on, EQ/RG off, full volume", () => {
    expect(isBitPerfect(clean)).toBe(true);
    expect(bitPerfectBlockers(clean)).toEqual([]);
  });

  it("tolerates float volume that rounds to 100%", () => {
    expect(isBitPerfect({ ...clean, volume: 0.9995 })).toBe(true);
  });

  it("flags each blocker independently", () => {
    expect(bitPerfectBlockers({ ...clean, exclusive: false })).toEqual(["exclusive off"]);
    expect(bitPerfectBlockers({ ...clean, eqEnabled: true })).toEqual(["EQ"]);
    expect(bitPerfectBlockers({ ...clean, rgMode: "track" })).toEqual(["ReplayGain"]);
    expect(bitPerfectBlockers({ ...clean, rgMode: "album" })).toEqual(["ReplayGain"]);
    expect(bitPerfectBlockers({ ...clean, volume: 0.57 })).toEqual(["volume 57%"]);
  });

  it("lists multiple blockers in display order", () => {
    expect(
      bitPerfectBlockers({ exclusive: true, eqEnabled: true, rgMode: "track", volume: 0.57 }),
    ).toEqual(["EQ", "ReplayGain", "volume 57%"]);
  });

  it("never reports bit-perfect without exclusive access", () => {
    expect(isBitPerfect({ ...clean, exclusive: false })).toBe(false);
  });
});
