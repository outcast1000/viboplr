import { describe, it, expect } from "vitest";
import { trackLikePayload, entityLikePayload, nextTriState } from "../likeKeys";
import type { QueueTrack } from "../types";

function makeTrack(over: Partial<QueueTrack> = {}): QueueTrack {
  return {
    key: "ext:1", path: "custom://1", title: "Jóga", artist_name: "Björk",
    album_title: "Homogenic", duration_secs: 180, format: null, liked: 0, ...over,
  };
}

describe("trackLikePayload", () => {
  it("maps a QueueTrack to the backend entity payload", () => {
    const p = trackLikePayload(makeTrack({ image_url: "http://x/y.jpg" }));
    expect(p).toEqual({
      title: "Jóga", artistName: "Björk", albumTitle: "Homogenic",
      durationSecs: 180, source: "custom://1", imageUrl: "http://x/y.jpg",
    });
  });
  it("handles null fields", () => {
    const p = trackLikePayload(makeTrack({ artist_name: null, album_title: null, path: null, duration_secs: null }));
    expect(p.artistName).toBeNull();
    expect(p.albumTitle).toBeNull();
    expect(p.source).toBeNull();
  });
});

describe("entityLikePayload", () => {
  it("builds an artist/album/tag payload from a name", () => {
    expect(entityLikePayload("Björk")).toEqual({
      title: "Björk", artistName: null, albumTitle: null,
      durationSecs: null, source: null, imageUrl: null,
    });
  });
  it("includes artist for albums", () => {
    expect(entityLikePayload("Homogenic", "Björk").artistName).toBe("Björk");
  });
});

describe("nextTriState", () => {
  it("toggles like on/off", () => {
    expect(nextTriState(0, "like")).toBe(1);
    expect(nextTriState(1, "like")).toBe(0);
    expect(nextTriState(-1, "like")).toBe(1);
  });
  it("toggles dislike on/off", () => {
    expect(nextTriState(0, "dislike")).toBe(-1);
    expect(nextTriState(-1, "dislike")).toBe(0);
    expect(nextTriState(1, "dislike")).toBe(-1);
  });
});
