import { describe, it, expect } from "vitest";
import {
  coerceRadioOptions,
  DEFAULT_RADIO_OPTIONS,
  RADIO_ARTIST_SHARE_CHOICES,
  RADIO_TASTE_CHOICES,
} from "../utils/radioOptions";

// The persisted `radioOptions` object may come from an older build (missing
// fields), a hand-edited store, or a future build (unknown taste). Every field
// must fall back on its own so one bad value doesn't reset the others.
describe("coerceRadioOptions", () => {
  it("returns the defaults for anything that is not an object", () => {
    for (const raw of [undefined, null, 42, "mixed", true, []]) {
      expect(coerceRadioOptions(raw)).toEqual(DEFAULT_RADIO_OPTIONS);
    }
  });

  it("keeps valid fields and defaults the rest independently", () => {
    expect(coerceRadioOptions({ taste: "discovery" })).toEqual({ ...DEFAULT_RADIO_OPTIONS, taste: "discovery" });
    expect(coerceRadioOptions({ artistShare: 10, spreadArtists: true })).toEqual({ artistShare: 10, taste: "mixed", spreadArtists: true });
  });

  it("rejects an unknown taste and non-boolean spread without touching the share", () => {
    expect(coerceRadioOptions({ artistShare: 25, taste: "loud", spreadArtists: "yes" })).toEqual({ ...DEFAULT_RADIO_OPTIONS, artistShare: 25 });
  });

  it("clamps and rounds the share into 0–100", () => {
    expect(coerceRadioOptions({ artistShare: -5 }).artistShare).toBe(0);
    expect(coerceRadioOptions({ artistShare: 250 }).artistShare).toBe(100);
    expect(coerceRadioOptions({ artistShare: 24.6 }).artistShare).toBe(25);
    expect(coerceRadioOptions({ artistShare: Number.NaN }).artistShare).toBe(DEFAULT_RADIO_OPTIONS.artistShare);
  });

  it("offers the default share and taste among the Settings choices", () => {
    // Otherwise the select would render blank for a fresh profile.
    expect(RADIO_ARTIST_SHARE_CHOICES.some((c) => c.value === DEFAULT_RADIO_OPTIONS.artistShare)).toBe(true);
    expect(RADIO_TASTE_CHOICES.some((c) => c.value === DEFAULT_RADIO_OPTIONS.taste)).toBe(true);
  });
});
