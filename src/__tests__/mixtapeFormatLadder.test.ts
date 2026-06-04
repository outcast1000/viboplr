import { describe, it, expect } from "vitest";
import { MIXTAPE_FORMAT_LADDER, MIXTAPE_FORMAT_DEFAULT } from "../utils/mixtapeFormatLadder";

describe("MIXTAPE_FORMAT_LADDER", () => {
  it("lists formats highest-quality-first", () => {
    expect(MIXTAPE_FORMAT_LADDER.map(o => o.value)).toEqual([
      "flac-hires", "flac", "aac", "mp3",
    ]);
  });

  it("gives every option a non-empty label", () => {
    for (const opt of MIXTAPE_FORMAT_LADDER) {
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });

  it("defaults to flac", () => {
    expect(MIXTAPE_FORMAT_DEFAULT).toBe("flac");
    expect(MIXTAPE_FORMAT_LADDER.some(o => o.value === MIXTAPE_FORMAT_DEFAULT)).toBe(true);
  });
});
