import { describe, it, expect } from "vitest";
import {
  photoSlidesFrom,
  withPhotoSlides,
  slideIndexAt,
  nextSlidePosition,
  SLIDESHOW_START,
  NOW_PLAYING_PHOTO_CAP,
} from "../utils/nowPlayingArt";
import { galleryImageCredit, galleryImages, type GalleryImage, type TrackGallery } from "../utils/trackGalleries";

const imgs = (prefix: string, n: number): GalleryImage[] =>
  Array.from({ length: n }, (_, i) => ({ url: `https://${prefix}/${i}.jpg` }));

describe("photoSlidesFrom", () => {
  it("deals song, then artist, then album galleries round-robin across sources", () => {
    const galleries: TrackGallery[] = [
      { about: "album", typeId: "a", name: "A", images: imgs("album", 1) },
      { about: "artist", typeId: "getty", name: "Getty", images: imgs("getty", 3) },
      { about: "artist", typeId: "commons", name: "Commons", images: imgs("commons", 2) },
    ];
    expect(photoSlidesFrom(galleries).map((p) => p.url)).toEqual([
      "https://getty/0.jpg",
      "https://commons/0.jpg",
      "https://album/0.jpg",
      "https://getty/1.jpg",
      "https://commons/1.jpg",
      "https://getty/2.jpg",
    ]);
  });

  it("keeps a picture two sources share once", () => {
    const same = [{ url: "https://x/1.jpg" }];
    const out = photoSlidesFrom([
      { about: "artist", typeId: "a", name: "A", images: same },
      { about: "artist", typeId: "b", name: "B", images: same },
    ]);
    expect(out).toHaveLength(1);
  });

  it("caps the show", () => {
    const out = photoSlidesFrom([
      { about: "artist", typeId: "a", name: "A", images: imgs("a", 30) },
      { about: "artist", typeId: "b", name: "B", images: imgs("b", 30) },
    ]);
    expect(out).toHaveLength(NOW_PLAYING_PHOTO_CAP);
  });

  it("carries the credit and the photo's page", () => {
    const [p] = photoSlidesFrom([{
      about: "artist", typeId: "getty", name: "Getty",
      images: [{ url: "https://g/1.jpg", author: "Jane Doe", source: "Getty Images / Redferns", pageUrl: "https://www.gettyimages.com/detail/1" }],
    }]);
    expect(p).toEqual({
      url: "https://g/1.jpg",
      credit: "Jane Doe · Getty Images / Redferns",
      pageUrl: "https://www.gettyimages.com/detail/1",
    });
  });
});

describe("galleryImageCredit", () => {
  it("doesn't name the author twice when the source already does (Commons)", () => {
    expect(galleryImageCredit({ url: "u", author: "Jane", source: "Jane · CC BY-SA 4.0" })).toBe("Jane · CC BY-SA 4.0");
  });
  it("falls back to whichever half there is", () => {
    expect(galleryImageCredit({ url: "u", source: "Wikimedia Commons" })).toBe("Wikimedia Commons");
    expect(galleryImageCredit({ url: "u", author: "Jane" })).toBe("Jane");
    expect(galleryImageCredit({ url: "u" })).toBeNull();
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
