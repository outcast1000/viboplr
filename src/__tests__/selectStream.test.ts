import { describe, it, expect } from "vitest";
import { selectStream } from "../playback/selectStream";
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
  it("native engine picks best video-only + audio-only, with muxed browser fallback", () => {
    const r = selectStream(YT, { engine: "native", video: true });
    expect(r).not.toBeNull();
    expect(r!.url).toBe("v1080"); // best mp4/avc video-only
    expect(r!.audioUrl).toBe("am4a"); // browser-safe audio preferred
    expect(r!.headers).toEqual({ "User-Agent": "yt-dlp" });
    expect(r!.browserUrl).toBe("mux360"); // self-contained fallback
    expect(r!.video).toBe(true);
  });

  it("browser engine picks the self-contained muxed stream (no audioUrl)", () => {
    const r = selectStream(YT, { engine: "browser", video: true });
    expect(r!.url).toBe("mux360");
    expect(r!.browserUrl).toBe("mux360");
    expect(r!.audioUrl).toBeUndefined();
  });

  it("native falls back to muxed when there is no split pair", () => {
    const onlyMuxed: StreamCandidate[] = [
      { url: "mux720", kind: "muxed", height: 720, container: "mp4", vcodec: "avc1", acodec: "mp4a" },
    ];
    const r = selectStream(onlyMuxed, { engine: "native", video: true });
    expect(r!.url).toBe("mux720");
    expect(r!.audioUrl).toBeUndefined();
  });

  it("prefers avc/mp4 video over vp9/webm at equal resolution", () => {
    const r = selectStream(YT, { engine: "native", video: true });
    expect(r!.url).toBe("v1080"); // not v1080vp9
  });

  it("uses an HLS master tagged muxed when there is no progressive muxed", () => {
    const hls: StreamCandidate[] = [
      { url: "hlsmaster", kind: "muxed", container: "m3u8" },
      { url: "v1080", kind: "video", height: 1080, container: "mp4", vcodec: "avc1" },
      { url: "am4a", kind: "audio", container: "m4a", acodec: "mp4a" },
    ];
    const nat = selectStream(hls, { engine: "native", video: true });
    expect(nat!.url).toBe("v1080");
    expect(nat!.browserUrl).toBe("hlsmaster");
    const br = selectStream(hls, { engine: "browser", video: true });
    expect(br!.url).toBe("hlsmaster");
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
    const r = selectStream(only, { engine: "browser", video: false });
    expect(r!.url).toBe("a1");
    expect(r!.browserUrl).toBe("a1");
    expect(r!.video).toBe(false);
    expect(r!.headers).toEqual(headers);
  });

  it("leaves headers undefined when the chosen audio stream declares none", () => {
    const r = selectStream(YT, { engine: "browser", video: false });
    expect(r!.url).toBe("am4a");
    expect(r!.headers).toBeUndefined();
  });

  it("native prefers highest-quality browser-safe audio; browserUrl is m4a", () => {
    const r = selectStream(YT, { engine: "native", video: false });
    expect(r!.video).toBe(false);
    expect(r!.url).toBe("am4a");
    expect(r!.browserUrl).toBe("am4a");
    expect(r!.audioUrl).toBeUndefined();
  });

  it("falls back to opus for native when no m4a exists, but browserUrl stays opus too", () => {
    const opusOnly: StreamCandidate[] = [
      { url: "aopus", kind: "audio", container: "webm", acodec: "opus", tbr: 160 },
    ];
    const r = selectStream(opusOnly, { engine: "native", video: false });
    expect(r!.url).toBe("aopus");
    expect(r!.browserUrl).toBe("aopus");
  });
});

describe("selectStream — edge cases", () => {
  it("returns null for an empty candidate list", () => {
    expect(selectStream([], { engine: "native", video: true })).toBeNull();
    expect(selectStream([], { engine: "browser", video: false })).toBeNull();
  });

  it("returns null for video request with only audio candidates", () => {
    const audioOnly: StreamCandidate[] = [{ url: "am4a", kind: "audio", container: "m4a", acodec: "mp4a" }];
    expect(selectStream(audioOnly, { engine: "native", video: true })).toBeNull();
  });
});
