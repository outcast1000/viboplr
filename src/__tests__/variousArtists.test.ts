import { describe, it, expect } from "vitest";
import { isVariousArtists } from "../utils/variousArtists";

describe("isVariousArtists", () => {
  it("matches the common collective spellings, case-insensitively", () => {
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

  it("matches the unknown-artist placeholders", () => {
    // Rippers write these into ALBUMARTIST instead of leaving the tag empty,
    // so the album files under a placeholder artist row whose Last.fm page is
    // as much of a junk catch-all as "Various Artists".
    for (const name of [
      "Unknown Artist",
      "unknown artist",
      "UNKNOWN ARTIST",
      "  Unknown Artist  ",
      "Unknown",
      "unknown",
      "[unknown]",
      "<unknown>",
    ]) {
      expect(isVariousArtists(name), name).toBe(true);
    }
  });

  it("does not match real artist names", () => {
    for (const name of [
      "Björk",
      "Various Productions", // real UK duo — "Various" must match only exactly
      "Unknown Mortal Orchestra", // same, for "Unknown"
      "The Unknowns",
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
