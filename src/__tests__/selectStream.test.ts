import { describe, it, expect } from "vitest";
import { selectStream, selectedNeedsClassifying } from "../playback/selectStream";
import type { StreamCandidate } from "../types/plugin";

// Mirror of a typical YouTube menu: one muxed 360p, video-only up to 1080p,
// audio-only in m4a + opus.
const YT: StreamCandidate[] = [
  { url: "mux360", kind: "muxed", height: 360, container: "mp4", vcodec: "avc1", acodec: "mp4a", tbr: 360 },
  { url: "v1080", kind: "video", height: 1080, container: "mp4", vcodec: "avc1", tbr: 3248, headers: { "User-Agent": "yt-dlp" } },
  { url: "v1080vp9", kind: "video", height: 1080, container: "webm", vcodec: "vp9", tbr: 2127 },
  { url: "v720", kind: "video", height: 720, container: "mp4", vcodec: "avc1", tbr: 1898 },
  { url: "am4a", kind: "audio", container: "m4a", acodec: "mp4a", tbr: 129 },
  { url: "aopus", kind: "audio", container: "webm", acodec: "opus", tbr: 129 },
];

describe("selectStream — video", () => {
  it("picks the best video-only + audio-only pair", () => {
    const r = selectStream(YT, { video: true });
    expect(r).not.toBeNull();
    expect(r!.url).toBe("v1080"); // best mp4/avc video-only
    expect(r!.audioUrl).toBe("am4a"); // m4a/aac preferred
    expect(r!.headers).toEqual({ "User-Agent": "yt-dlp" });
    expect(r!.video).toBe(true);
  });

  it("falls back to muxed when there is no split pair", () => {
    const onlyMuxed: StreamCandidate[] = [
      { url: "mux720", kind: "muxed", height: 720, container: "mp4", vcodec: "avc1", acodec: "mp4a" },
    ];
    const r = selectStream(onlyMuxed, { video: true });
    expect(r!.url).toBe("mux720");
    expect(r!.audioUrl).toBeUndefined();
  });

  it("prefers avc/mp4 video over vp9/webm at equal resolution", () => {
    const r = selectStream(YT, { video: true });
    expect(r!.url).toBe("v1080"); // not v1080vp9
  });

  it("takes a split pair over an HLS master tagged muxed", () => {
    const hls: StreamCandidate[] = [
      { url: "hlsmaster", kind: "muxed", container: "m3u8" },
      { url: "v1080", kind: "video", height: 1080, container: "mp4", vcodec: "avc1" },
      { url: "am4a", kind: "audio", container: "m4a", acodec: "mp4a" },
    ];
    expect(selectStream(hls, { video: true })!.url).toBe("v1080");
    expect(selectStream([hls[0]], { video: true })!.url).toBe("hlsmaster");
  });
});

describe("selectStream — retry ladder", () => {
  it("steps down one video rung per failed attempt, keeping the same audio", () => {
    const first = selectStream(YT, { video: true, skipTopVideo: 0 });
    const second = selectStream(YT, { video: true, skipTopVideo: 1 });
    expect(first!.url).toBe("v1080");
    expect(second!.url).toBe("v720");
    expect(second!.audioUrl).toBe("am4a"); // audio is not stepped down with it
  });

  it("descends past the preferred encodings into the rest rather than stopping", () => {
    // v1080 and v720 are mp4/avc; v1080vp9 is not. A ladder that only walked the
    // preferred list would run out at step 2 while a playable vp9 stream was
    // still there.
    const third = selectStream(YT, { video: true, skipTopVideo: 2 });
    expect(third!.url).toBe("v1080vp9");
  });

  it("gives up on the split pair once the ladder runs off the end", () => {
    const past = selectStream(YT, { video: true, skipTopVideo: 9 });
    // No video-only rung left → the muxed stream. usePlayback caps the attempts
    // before this.
    expect(past!.url).toBe("mux360");
    expect(past!.audioUrl).toBeUndefined();
  });

  it("is unchanged when no ladder step is supplied", () => {
    expect(selectStream(YT, { video: true })!.url).toBe("v1080");
  });
});

describe("selectStream — audio", () => {
  it("carries the chosen audio stream's headers", () => {
    // A resolver that has already picked its stream answers with a ONE-element
    // candidate list, because that is the only shape in the contract that can
    // carry headers (the yt-dlp plugin does this for `ytdlp://` audio). Signed
    // CDN links bound to the minting User-Agent 403 without them, so dropping
    // them here would silently undo the whole point of that shape.
    const headers = { "User-Agent": "yt-dlp", Referer: "https://example/" };
    const only: StreamCandidate[] = [{ url: "a1", kind: "audio", headers }];
    const r = selectStream(only, { video: false });
    expect(r!.url).toBe("a1");
    expect(r!.video).toBe(false);
    expect(r!.headers).toEqual(headers);
  });

  it("leaves headers undefined when the chosen audio stream declares none", () => {
    const r = selectStream(YT, { video: false });
    expect(r!.url).toBe("am4a");
    expect(r!.headers).toBeUndefined();
  });

  it("prefers m4a/aac audio at equal bitrate and never pairs an audio pick", () => {
    const r = selectStream(YT, { video: false });
    expect(r!.video).toBe(false);
    expect(r!.url).toBe("am4a");
    expect(r!.audioUrl).toBeUndefined();
  });

  it("ranks audio by quality first — a higher-bitrate opus beats m4a", () => {
    const mixed: StreamCandidate[] = [
      { url: "am4a", kind: "audio", container: "m4a", acodec: "mp4a", tbr: 129 },
      { url: "aopus", kind: "audio", container: "webm", acodec: "opus", tbr: 160 },
    ];
    expect(selectStream(mixed, { video: false })!.url).toBe("aopus");
  });

  it("pairs a video pick with the best audio, and keeps avc video over a higher VP9 rung", () => {
    const yt: StreamCandidate[] = [
      { url: "v1080", kind: "video", height: 1080, container: "mp4", vcodec: "avc1" },
      { url: "v2160vp9", kind: "video", height: 2160, container: "webm", vcodec: "vp9" },
      { url: "am4a", kind: "audio", container: "m4a", acodec: "mp4a", tbr: 129 },
      { url: "aopus", kind: "audio", container: "webm", acodec: "opus", tbr: 160 },
    ];
    const r = selectStream(yt, { video: true });
    expect(r!.url).toBe("v1080");
    expect(r!.audioUrl).toBe("aopus");
  });

  it("takes opus when no m4a exists", () => {
    const opusOnly: StreamCandidate[] = [
      { url: "aopus", kind: "audio", container: "webm", acodec: "opus", tbr: 160 },
    ];
    expect(selectStream(opusOnly, { video: false })!.url).toBe("aopus");
  });
});

describe("selectStream — edge cases", () => {
  it("returns null for an empty candidate list", () => {
    expect(selectStream([], { video: true })).toBeNull();
    expect(selectStream([], { video: false })).toBeNull();
  });

  it("returns null for video request with only audio candidates", () => {
    const audioOnly: StreamCandidate[] = [{ url: "am4a", kind: "audio", container: "m4a", acodec: "mp4a" }];
    expect(selectStream(audioOnly, { video: true })).toBeNull();
  });
});

// A candidate is only a URL, and not every plugin scheme resolves to the
// network — the qBittorrent plugin's `qbt://` names a file already on disk.
describe("selectedNeedsClassifying", () => {
  it("sends a non-http pick back through the URL classifier", () => {
    // Handing this to the http branch would tell mpv a local file is a network
    // stream.
    expect(selectedNeedsClassifying({ url: "file:///music/a.flac", video: false })).toBe(true);
  });

  it("leaves an ordinary http stream on the http path", () => {
    expect(selectedNeedsClassifying({ url: "https://cdn/x.m4a", video: false })).toBe(false);
    expect(selectedNeedsClassifying({ url: "http://cdn/x.m4a", video: false })).toBe(false);
  });

  it("never reroutes a split video pick", () => {
    // `audioUrl` and `headers` have nowhere to ride through the classifier, and
    // a split pair is always http anyway.
    expect(selectedNeedsClassifying({
      url: "https://cdn/v.mp4", audioUrl: "https://cdn/a.m4a", video: true,
    })).toBe(false);
  });
});
