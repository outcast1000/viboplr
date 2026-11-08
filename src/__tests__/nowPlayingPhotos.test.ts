import { describe, it, expect } from "vitest";
import {
  photoSlidesFrom,
  withPhotoSlides,
  slideIndexAt,
  nextSlidePosition,
  SLIDESHOW_START,
  NOW_PLAYING_PHOTO_CAP,
} from "../utils/nowPlayingArt";
import { galleryImages } from "../utils/trackGalleries";
import type { ContextImage } from "../types/plugin";
import type { ContextImageBatch } from "../utils/contextImages";

const imgs = (prefix: string, n: number): ContextImage[] =>
  Array.from({ length: n }, (_, i) => ({ url: `https://${prefix}/${i}.jpg` }));
const batch = (providerKey: string, order: number, images: ContextImage[]): ContextImageBatch =>
  ({ providerKey, providerName: providerKey, order, images });

describe("photoSlidesFrom", () => {
  it("shows the best fits first, whichever source they came from", () => {
    const out = photoSlidesFrom([
      batch("commons", 0, [{ url: "https://c/old.jpg", relevance: 0.2 }, { url: "https://c/era.jpg", relevance: 0.9 }]),
      batch("getty", 1, [{ url: "https://g/era.jpg", relevance: 0.95 }]),
    ]);
    expect(out.map((p) => p.url)).toEqual(["https://g/era.jpg", "https://c/era.jpg", "https://c/old.jpg"]);
  });

  it("deals equal fits round-robin across sources, so a prolific one doesn't bury another", () => {
    const out = photoSlidesFrom([batch("getty", 0, imgs("getty", 3)), batch("commons", 1, imgs("commons", 2))]);
    expect(out.map((p) => p.url)).toEqual([
      "https://getty/0.jpg", "https://commons/0.jpg", "https://getty/1.jpg", "https://commons/1.jpg", "https://getty/2.jpg",
    ]);
  });

  it("keeps a picture two sources share once, and caps the show", () => {
    expect(photoSlidesFrom([batch("a", 0, imgs("x", 1)), batch("b", 1, imgs("x", 1))])).toHaveLength(1);
    expect(photoSlidesFrom([batch("a", 0, imgs("a", 30)), batch("b", 1, imgs("b", 30))])).toHaveLength(NOW_PLAYING_PHOTO_CAP);
  });

  it("carries the credit (with the year) and the photo's page", () => {
    const [p] = photoSlidesFrom([batch("getty", 0, [{
      url: "https://g/1.jpg", author: "Jane Doe", source: "Getty Images / Redferns", year: 1994,
      pageUrl: "https://www.gettyimages.com/detail/1",
    }])]);
    expect(p).toEqual({
      url: "https://g/1.jpg",
      credit: "Jane Doe · 1994 · Getty Images / Redferns",
      pageUrl: "https://www.gettyimages.com/detail/1",
    });
  });
});

describe("slide position", () => {
  const list = (...paths: string[]) => paths.map((path) => ({ path, photo: null }));

  it("stays on the picture on screen when photos land and the list is re-dealt", () => {
    const before = list("cover", "artist", "commons0");
    const pos = nextSlidePosition(before, nextSlidePosition(before, SLIDESHOW_START));
    expect(before[slideIndexAt(before, pos)].path).toBe("commons0");
    // Getty lands: round-robin puts its first photo ahead of commons0.
    const after = list("cover", "artist", "getty0", "commons0", "getty1");
    expect(after[slideIndexAt(after, pos)].path).toBe("commons0");
    expect(after[slideIndexAt(after, nextSlidePosition(after, pos))].path).toBe("getty1");
  });

  it("falls back to the index when the picture left the list (it failed to load)", () => {
    const pos = { path: "dead", idx: 2 };
    const l = list("cover", "artist", "next", "last");
    expect(l[slideIndexAt(l, pos)].path).toBe("next");
  });

  it("starts on the first slide and wraps", () => {
    const l = list("a", "b");
    expect(slideIndexAt(l, SLIDESHOW_START)).toBe(0);
    expect(nextSlidePosition(l, { path: "b", idx: 1 })).toEqual({ path: "a", idx: 0 });
  });
});

describe("galleryImages page links", () => {
  it("keeps only web pages as a photo's page", () => {
    const out = galleryImages({ images: [
      { url: "https://x/1.jpg", pageUrl: "https://commons.wikimedia.org/wiki/File:1.jpg" },
      { url: "https://x/2.jpg", pageUrl: "file:///Applications/Calculator.app" },
      { url: "https://x/3.jpg", pageUrl: "someapp://do-thing" },
    ] });
    expect(out.map((i) => i.pageUrl)).toEqual(["https://commons.wikimedia.org/wiki/File:1.jpg", undefined, undefined]);
  });
});

describe("withPhotoSlides", () => {
  it("puts the track's own art first and drops a photo that repeats it", () => {
    const out = withPhotoSlides(["/cover.jpg", "https://a/artist.jpg"], [
      { url: "https://a/artist.jpg", credit: null },
      { url: "https://p/1.jpg", credit: "X" },
    ]);
    expect(out.map((s) => [s.path, s.photo?.credit ?? null])).toEqual([
      ["/cover.jpg", null],
      ["https://a/artist.jpg", null],
      ["https://p/1.jpg", "X"],
    ]);
  });
});
