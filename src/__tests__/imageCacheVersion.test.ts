import { describe, it, expect, vi } from "vitest";

// resolveImageUrl calls Tauri's convertFileSrc for local paths; stub it so the
// test runs without the Tauri runtime and we can assert the #v= -> ?v= round-trip.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

import { imageUrlWithVersion } from "../hooks/useImageCache";
import { resolveImageUrl } from "../utils/resolveImageUrl";

describe("imageUrlWithVersion", () => {
  it("returns the plain path when version is 0 (never refreshed)", () => {
    // The common case — no #v= suffix, so existing convertFileSrc consumers are
    // unaffected until an image is actually re-fetched.
    expect(imageUrlWithVersion("/imgs/album.jpg", 0)).toBe("/imgs/album.jpg");
  });

  it("appends #v=N to a local path once it has been refreshed", () => {
    expect(imageUrlWithVersion("/imgs/album.jpg", 1)).toBe("/imgs/album.jpg#v=1");
    expect(imageUrlWithVersion("/imgs/album.jpg", 4)).toBe("/imgs/album.jpg#v=4");
  });

  it("returns null for a missing path regardless of version", () => {
    expect(imageUrlWithVersion(null, 3)).toBeNull();
    expect(imageUrlWithVersion("", 3)).toBeNull();
  });

  it("does not version remote/data URLs (resolveImageUrl serves those as-is)", () => {
    expect(imageUrlWithVersion("https://cdn/x.jpg", 2)).toBe("https://cdn/x.jpg");
    expect(imageUrlWithVersion("http://cdn/x.jpg", 2)).toBe("http://cdn/x.jpg");
    expect(imageUrlWithVersion("data:image/png;base64,AA", 2)).toBe("data:image/png;base64,AA");
  });
});

describe("resolveImageUrl round-trips a versioned cache path", () => {
  it("translates the #v=N produced by imageUrlWithVersion into a ?v=N cache-buster", () => {
    const versioned = imageUrlWithVersion("/imgs/album.jpg", 2)!;
    expect(resolveImageUrl(versioned)).toBe("asset:///imgs/album.jpg?v=2");
  });

  it("leaves an unversioned path as a plain asset URL", () => {
    expect(resolveImageUrl(imageUrlWithVersion("/imgs/album.jpg", 0))).toBe("asset:///imgs/album.jpg");
  });
});
