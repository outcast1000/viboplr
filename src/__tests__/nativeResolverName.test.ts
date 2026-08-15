import { describe, it, expect } from "vitest";
import { nativeResolverName } from "../queueEntry";

// The name of a track's OWN source. It is user-facing twice over: it titles the
// source panel, and it fills in the panel's "Open on ___" button.
const names = (protocol: string): string | null =>
  protocol === "ytdlp" ? "yt-dlp" : protocol === "tidal" ? "TIDAL" : null;

describe("nativeResolverName", () => {
  it("names the built-in schemes", () => {
    expect(nativeResolverName("file:///music/a.flac", names)).toBe("Local");
    expect(nativeResolverName("/music/a.flac", names)).toBe("Local");
    expect(nativeResolverName("subsonic://1/42", names)).toBe("Subsonic");
    expect(nativeResolverName("https://example.com/a.mp3", names)).toBe("Direct URL");
    expect(nativeResolverName("http://example.com/a.mp3", names)).toBe("Direct URL");
  });

  it("prefers the owning plugin's own name over its URL scheme", () => {
    // The scheme is an implementation detail the plugin never chose to show:
    // "ytdlp" capitalizes to "Ytdlp", which is not what the plugin calls itself
    // and reads as a typo in "Open on Ytdlp".
    expect(nativeResolverName("ytdlp://abc", names)).toBe("yt-dlp");
    expect(nativeResolverName("tidal://12345", names)).toBe("TIDAL");
  });

  it("falls back to the capitalized scheme when nothing owns it", () => {
    // An uninstalled/disabled plugin still leaves its tracks in the queue, so
    // this has to name them somehow rather than render blank.
    expect(nativeResolverName("spotify://xyz", names)).toBe("Spotify");
    expect(nativeResolverName("ytdlp://abc", () => null)).toBe("Ytdlp");
    expect(nativeResolverName("ytdlp://abc")).toBe("Ytdlp");
  });

  it("falls back when a plugin reports an empty name", () => {
    // A manifest with a blank name must not blank out the panel title.
    expect(nativeResolverName("ytdlp://abc", () => "")).toBe("Ytdlp");
  });
});
