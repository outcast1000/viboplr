import { describe, it, expect } from "vitest";
import { isVariousArtists } from "../utils/variousArtists";

describe("isVariousArtists", () => {
  it("matches the common tagger spellings, case-insensitively", () => {
    for (const name of [
      "Various Artists",
      "various artists",
      "VARIOUS ARTISTS",
      "  Various Artists  ",
      "Various",
      "VA",
      "va",
      "V.A.",
      "V/A",
    ]) {
      expect(isVariousArtists(name), name).toBe(true);
    }
  });

  it("does not match real artist names", () => {
    for (const name of [
      "Björk",
      "Various Productions", // real UK duo — "Various" must match only exactly
      "The Vandals",
      "Vangelis",
      "",
    ]) {
      expect(isVariousArtists(name), name || "(empty)").toBe(false);
    }
    expect(isVariousArtists(null)).toBe(false);
    expect(isVariousArtists(undefined)).toBe(false);
  });
});
