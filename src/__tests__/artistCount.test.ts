import { describe, it, expect } from "vitest";
import { artistCountLabel } from "../utils/artistCount";

describe("artistCountLabel", () => {
  it("names tracks when the artist performs on any", () => {
    expect(artistCountLabel({ track_count: 12, album_count: 2 })).toBe("12 tracks");
  });

  it("falls back to albums for an album-artist-only artist", () => {
    // The reported case: a compilation tagged ALBUMARTIST="Unknown Artist"
    // owns the album, but no track performs under that name — so the row is
    // listed with track_count 0 and used to read "0 tracks".
    expect(artistCountLabel({ track_count: 0, album_count: 1 })).toBe("1 album");
  });

  it("singularizes both nouns", () => {
    expect(artistCountLabel({ track_count: 1, album_count: 0 })).toBe("1 track");
    expect(artistCountLabel({ track_count: 0, album_count: 3 })).toBe("3 albums");
  });

  it("reports zero albums rather than NaN when the count is absent", () => {
    expect(artistCountLabel({ track_count: 0 })).toBe("0 albums");
  });
});
