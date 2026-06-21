import { describe, it, expect, vi } from "vitest";

// resolveTrackImage routes album/artist paths through resolveImageUrl, which
// calls Tauri's convertFileSrc for local paths. Stub it so the test runs without
// the Tauri runtime and so we can assert the conversion + cache-bust behavior.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

import { pickEntityImagePath, resolveTrackImage } from "../utils/trackImage";

const lookups = {
  albumImageFor: (album: string, artist?: string) =>
    album === "Greatest" ? `/covers/${artist ?? "?"}-${album}.jpg` : null,
  artistImageFor: (artist: string) => (artist === "Artie" ? `/artists/${artist}.jpg` : null),
};

describe("pickEntityImagePath", () => {
  it("prefers the album image over the artist image", () => {
    expect(
      pickEntityImagePath({ album_title: "Greatest", artist_name: "Artie" }, lookups),
    ).toBe("/covers/Artie-Greatest.jpg");
  });

  it("falls back to the artist image when there is no album hit", () => {
    expect(
      pickEntityImagePath({ album_title: "Unknown", artist_name: "Artie" }, lookups),
    ).toBe("/artists/Artie.jpg");
  });

  it("returns null when neither resolves", () => {
    expect(pickEntityImagePath({ album_title: "Unknown", artist_name: "Nobody" }, lookups)).toBeNull();
    expect(pickEntityImagePath({}, lookups)).toBeNull();
  });
});

describe("resolveTrackImage", () => {
  it("uses an explicit image_url first, converted via resolveImageUrl", () => {
    const src = resolveTrackImage(
      { image_url: "/explicit/cover.jpg", album_title: "Greatest", artist_name: "Artie" },
      { ...lookups, videoFrame: "asset://frame.jpg" },
    );
    expect(src).toBe("asset:///explicit/cover.jpg");
  });

  it("passes a remote image_url through unchanged", () => {
    expect(
      resolveTrackImage({ image_url: "https://cdn/x.jpg" }, lookups),
    ).toBe("https://cdn/x.jpg");
  });

  it("uses an already-converted video frame verbatim (no re-conversion)", () => {
    const src = resolveTrackImage(
      { album_title: "Greatest", artist_name: "Artie" },
      { ...lookups, videoFrame: "asset://frames/1.jpg" },
    );
    expect(src).toBe("asset://frames/1.jpg");
  });

  it("falls back to the album image (converted) when no image_url or video frame", () => {
    expect(
      resolveTrackImage({ album_title: "Greatest", artist_name: "Artie" }, { ...lookups, videoFrame: null }),
    ).toBe("asset:///covers/Artie-Greatest.jpg");
  });

  it("falls back to the artist image when there is no album", () => {
    expect(
      resolveTrackImage({ artist_name: "Artie" }, lookups),
    ).toBe("asset:///artists/Artie.jpg");
  });

  it("translates a #v=N cache-buster into a ?v=N query on local paths", () => {
    expect(
      resolveTrackImage({ image_url: "/covers/c.jpg#v=7" }, lookups),
    ).toBe("asset:///covers/c.jpg?v=7");
  });

  it("returns null when nothing resolves (placeholder territory)", () => {
    expect(resolveTrackImage({ title: "x" }, lookups)).toBeNull();
  });
});
