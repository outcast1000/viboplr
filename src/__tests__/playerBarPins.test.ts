import { describe, it, expect } from "vitest";
import {
  DEFAULT_PLAYER_BAR_PINS,
  bitPerfectOnBar,
  eqOnBar,
  normalizePlayerBarPins,
} from "../utils/playerBarPins";

describe("normalizePlayerBarPins", () => {
  it("pins nothing by default", () => {
    expect(DEFAULT_PLAYER_BAR_PINS).toEqual({ eq: false, bitPerfect: false });
  });

  it.each([undefined, null, "eq", 42, []])("falls back to nothing pinned for %j", (raw) => {
    expect(normalizePlayerBarPins(raw)).toEqual({ eq: false, bitPerfect: false });
  });

  it("keeps only real booleans", () => {
    expect(normalizePlayerBarPins({ eq: true, bitPerfect: "yes" })).toEqual({ eq: true, bitPerfect: false });
    expect(normalizePlayerBarPins({ bitPerfect: true })).toEqual({ eq: false, bitPerfect: true });
  });
});

describe("eqOnBar", () => {
  const none = { eq: false, bitPerfect: false };

  it("hides an EQ that is off, unpinned and closed", () => {
    expect(eqOnBar(none, false, false)).toBe(false);
  });

  it("shows while the EQ is on", () => {
    expect(eqOnBar(none, true, false)).toBe(true);
  });

  // "Equalizer settings…" in the Audio options menu opens the popover, which
  // anchors to the EQ button — so the button must mount for it even while off.
  it("shows while its popover is open, so the popover has an anchor", () => {
    expect(eqOnBar(none, false, true)).toBe(true);
  });

  it("shows while pinned", () => {
    expect(eqOnBar({ eq: true, bitPerfect: false }, false, false)).toBe(true);
  });
});

describe("bitPerfectOnBar", () => {
  it("follows the mode, or the pin", () => {
    expect(bitPerfectOnBar({ eq: false, bitPerfect: false }, false)).toBe(false);
    expect(bitPerfectOnBar({ eq: false, bitPerfect: false }, true)).toBe(true);
    expect(bitPerfectOnBar({ eq: false, bitPerfect: true }, false)).toBe(true);
  });

  it("ignores the EQ pin", () => {
    expect(bitPerfectOnBar({ eq: true, bitPerfect: false }, false)).toBe(false);
  });
});
