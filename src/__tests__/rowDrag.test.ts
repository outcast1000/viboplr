import { describe, it, expect } from "vitest";
import { reorderList } from "../utils/rowDrag";

describe("reorderList", () => {
  const LIST = ["a", "b", "c", "d"];

  it("moves an item up", () => {
    expect(reorderList(LIST, 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("moves an item down", () => {
    expect(reorderList(LIST, 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("is a no-op for the same index or an out-of-range source", () => {
    expect(reorderList(LIST, 1, 1)).toBe(LIST);
    expect(reorderList(LIST, 9, 0)).toBe(LIST);
    expect(reorderList(LIST, -1, 0)).toBe(LIST);
  });

  it("does not mutate the input", () => {
    reorderList(LIST, 0, 3);
    expect(LIST).toEqual(["a", "b", "c", "d"]);
  });

  it("builds the Now Playing info order from three drags", () => {
    // Registration order → Artist · Album, Quality, Scrobbles, Synced Lyrics.
    let order = ["builtin:artist-album", "builtin:artist", "builtin:quality", "builtin:lyrics-synced", "lastfm:scrobbles"];
    order = reorderList(order, 2, 1); // Quality → 2nd
    order = reorderList(order, 4, 2); // Scrobbles → 3rd
    expect(order).toEqual([
      "builtin:artist-album",
      "builtin:quality",
      "lastfm:scrobbles",
      "builtin:artist",
      "builtin:lyrics-synced",
    ]);
    order = reorderList(order, 4, 3); // Synced Lyrics → 4th
    expect(order).toEqual([
      "builtin:artist-album",
      "builtin:quality",
      "lastfm:scrobbles",
      "builtin:lyrics-synced",
      "builtin:artist",
    ]);
  });
});
