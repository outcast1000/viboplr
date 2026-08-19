import { describe, it, expect } from "vitest";
import { attributedSourceUrl } from "../hooks/useStreamResolution";
import { effectiveLocalPath } from "../queueEntry";
import { isVideoTrack, videoContainerFromPath } from "../utils";

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

// The other consumer of the same attributed path: a plugin URI carries no
// extension, so `isVideoTrack` can only ever call it audio — and a downloaded
// .mkv then played through the <audio> element (sound, no picture). The resolver
// chain patches `format` from the file the scheme resolved to instead.
describe("videoContainerFromPath", () => {
  it("names a video container", () => {
    expect(videoContainerFromPath("file://D:/T/Concert.mkv")).toBe("mkv");
    expect(videoContainerFromPath("D:/T/clip.MP4")).toBe("mp4");
    expect(videoContainerFromPath("/home/a/b.webm")).toBe("webm");
  });

  it("is silent about audio", () => {
    // Not "flac" — this only ever ADDS a video classification. Reporting audio
    // containers would start writing `format` on tracks that already play right.
    expect(videoContainerFromPath("file://D:/T/03 - Nude.flac")).toBeNull();
    expect(videoContainerFromPath("file://D:/T/x.mp3")).toBeNull();
  });

  it("finds nothing in an extension-less plugin URI", () => {
    // The whole reason the field can't come from the URI.
    expect(videoContainerFromPath("qbt://abc123/3")).toBeNull();
    expect(videoContainerFromPath("spotify://4cOdK2wGLETKBW3PvgPWqT")).toBeNull();
    expect(videoContainerFromPath(null)).toBeNull();
    expect(videoContainerFromPath(undefined)).toBeNull();
  });

  it("reads the filename, not a dotted directory", () => {
    expect(videoContainerFromPath("D:/My.Videos/no-extension")).toBeNull();
    expect(videoContainerFromPath("D:/My.Videos/real.mkv")).toBe("mkv");
  });

  it("ignores a query or fragment suffix", () => {
    // extensionFromPath strips both; a signed stream URL routinely carries one.
    expect(videoContainerFromPath("https://cdn/x.mp4?token=abc")).toBe("mp4");
    expect(videoContainerFromPath("file://D:/T/a.mkv#v=12")).toBe("mkv");
  });
});

// The composition that actually fixes the bug, end to end: resolved file →
// attributed path → container → the classifier that routes playback.
describe("classifying a plugin-scheme track from its resolved file", () => {
  const container = (reported: string | undefined, path: string) =>
    videoContainerFromPath(attributedSourceUrl(reported, { kind: "file", path }));

  it("turns an unclassified qbt:// video into video", () => {
    const track = { path: "qbt://abc123/3", format: null };
    expect(isVideoTrack(track)).toBe(false);
    // No `sourceUrl` reported (an older plugin build) — derived from engineSource.
    const format = container(undefined, "D:/Torrents/Concert.2019.1080p.mkv");
    expect(isVideoTrack({ ...track, format })).toBe(true);
  });

  it("leaves an audio file alone", () => {
    const track = { path: "qbt://abc123/3", format: null };
    const format = container("file://D:/Torrents/03 - Nude.flac", "D:/Torrents/03 - Nude.flac");
    expect(format).toBeNull();
    expect(isVideoTrack({ ...track, format })).toBe(false);
  });

  it("never overturns a format the track already knows", () => {
    // "A known format is authoritative" — a real mp3 with a misleading name must
    // stay audio. The chain also gates on !isVideoTrack(track), so this is belt
    // and braces on the same rule.
    const track = { path: "qbt://abc123/3", format: "mp3" };
    expect(isVideoTrack(track)).toBe(false);
    expect(isVideoTrack({ ...track, format: track.format })).toBe(false);
  });
});
