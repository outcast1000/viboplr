import { describe, it, expect } from "vitest";
import { attributedSourceUrl } from "../hooks/useStreamResolution";
import { effectiveLocalPath } from "../queueEntry";

// A plugin scheme is an opaque id, so the source panel can only name what the
// resolution reported. When a plugin reports nothing but the resolution landed
// on a file, the host is still holding the path — and that is the whole answer
// the panel needs (path row, Open folder, and a tag read that can state the
// file's real bit depth).
describe("attributedSourceUrl", () => {
  it("keeps what the resolver reported", () => {
    expect(attributedSourceUrl("https://youtube.com/watch?v=x", { kind: "http", url: "https://cdn/x" }))
      .toBe("https://youtube.com/watch?v=x");
    // Even over a file: only the resolver knows if the file came from a page.
    expect(attributedSourceUrl("file://D:/a.flac", { kind: "file", path: "D:/b.flac" }))
      .toBe("file://D:/a.flac");
  });

  it("derives the path when the resolution landed on a file", () => {
    // The qBittorrent case on any host older than the version its own
    // reporting is gated on: no `sourceUrl`, but the bytes are right here.
    expect(attributedSourceUrl(undefined, { kind: "file", path: "D:/Torrents/03 - Nude.flac" }))
      .toBe("file://D:/Torrents/03 - Nude.flac");
  });

  it("leaves a genuine stream alone", () => {
    expect(attributedSourceUrl(undefined, { kind: "http", url: "https://cdn/x" })).toBeNull();
    expect(attributedSourceUrl(undefined, null)).toBeNull();
  });

  // The two halves in one: what the chain attributes has to be something
  // `effectiveLocalPath` can then recognise, or the panel still shows the URI.
  it("hands the panel a path it can use", () => {
    const attributed = attributedSourceUrl(undefined, { kind: "file", path: "D:/Torrents/03 - Nude.flac" });
    expect(effectiveLocalPath({ path: "qbt://abc/3" }, { name: "qBittorrent", sourceUrl: attributed }))
      .toBe("D:/Torrents/03 - Nude.flac");
  });
});
