import { describe, it, expect } from "vitest";
import { withHostTabs } from "../utils/hostTabs";

describe("withHostTabs", () => {
  it("puts host tabs first, in order, when the saved order predates them", () => {
    expect(withHostTabs(["artist_bio", "similar_artists"], ["tracks", "tags"]))
      .toEqual(["tracks", "tags", "artist_bio", "similar_artists"]);
  });

  it("keeps a host tab the user dragged, and slots a new one right after it", () => {
    expect(withHostTabs(["artist_bio", "tracks", "similar_artists"], ["tracks", "tags"]))
      .toEqual(["artist_bio", "tracks", "tags", "similar_artists"]);
  });

  it("leaves an order that already names every host tab alone", () => {
    expect(withHostTabs(["tags", "artist_bio", "tracks"], ["tracks", "tags"]))
      .toEqual(["tags", "artist_bio", "tracks"]);
  });

  it("works from an empty saved order", () => {
    expect(withHostTabs([], ["tracks", "tags"])).toEqual(["tracks", "tags"]);
  });
});
