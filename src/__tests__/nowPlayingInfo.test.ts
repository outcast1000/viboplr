import { describe, it, expect } from "vitest";
import {
  isNowPlayingItemSelected,
  formatPlays,
  formatSource,
  formatQuality,
  formatTags,
  nextCycleIndex,
  type NowPlayingInfoDescriptor,
} from "../hooks/useNowPlayingInfo";

const ITEMS: NowPlayingInfoDescriptor[] = [
  { id: "builtin:artist-album", label: "Artist · Album", defaultEnabled: true },
  { id: "builtin:artist", label: "Artist", defaultEnabled: false },
  { id: "builtin:plays-rank", label: "Plays · Rank", defaultEnabled: true },
  { id: "lastfm:scrobbles", label: "Scrobbles", defaultEnabled: true },
];

describe("isNowPlayingItemSelected", () => {
  it("uses each item's registered default when there's no explicit choice", () => {
    expect(isNowPlayingItemSelected("builtin:artist-album", {}, ITEMS)).toBe(true);
    expect(isNowPlayingItemSelected("builtin:plays-rank", {}, ITEMS)).toBe(true);
    expect(isNowPlayingItemSelected("lastfm:scrobbles", {}, ITEMS)).toBe(true);
    expect(isNowPlayingItemSelected("builtin:artist", {}, ITEMS)).toBe(false);
  });

  it("falls back to off for an unknown item", () => {
    expect(isNowPlayingItemSelected("mystery:thing", {}, ITEMS)).toBe(false);
  });

  it("respects an explicit selection over the default", () => {
    expect(isNowPlayingItemSelected("builtin:artist-album", { "builtin:artist-album": false }, ITEMS)).toBe(false);
    expect(isNowPlayingItemSelected("builtin:artist", { "builtin:artist": true }, ITEMS)).toBe(true);
  });
});

describe("formatPlays", () => {
  it("returns null when there's nothing to show", () => {
    expect(formatPlays(0)).toBeNull();
    expect(formatPlays(null)).toBeNull();
    expect(formatPlays(undefined)).toBeNull();
    expect(formatPlays(-5)).toBeNull();
  });

  it("singularizes a single play", () => {
    expect(formatPlays(1)).toBe("1 play");
  });

  it("pluralizes multiple plays", () => {
    expect(formatPlays(2)).toBe("2 plays");
    expect(formatPlays(42)).toBe("42 plays");
  });
});

describe("formatSource", () => {
  it("maps schemes to readable names", () => {
    expect(formatSource("file:///music/a.flac")).toBe("Local");
    expect(formatSource("/music/a.flac")).toBe("Local");
    expect(formatSource("subsonic://1/42")).toBe("Subsonic");
    expect(formatSource("https://example.com/a.mp3")).toBe("Web");
    expect(formatSource("tidal://12345")).toBe("Tidal");
  });

  it("returns null for an unknown/empty path", () => {
    expect(formatSource(null)).toBeNull();
    expect(formatSource(undefined)).toBeNull();
    expect(formatSource("")).toBeNull();
  });
});

describe("formatQuality", () => {
  it("shows sample rate + bit depth for lossless", () => {
    expect(formatQuality("flac", { sample_rate: 44100, bit_depth: 16 })).toBe("FLAC · 44.1 kHz · 16-bit");
  });

  it("shows bitrate for lossy", () => {
    expect(formatQuality("mp3", { bitrate: 320 })).toBe("MP3 · 320 kbps");
  });

  it("falls back to format alone when no props", () => {
    expect(formatQuality("opus", null)).toBe("OPUS");
  });

  it("returns null when nothing is known", () => {
    expect(formatQuality(null, null)).toBeNull();
  });
});

describe("formatTags", () => {
  it("prefixes each tag with # and joins with a separator", () => {
    expect(formatTags(["rock", "jazz"])).toBe("#rock · #jazz");
    expect(formatTags(["80s"])).toBe("#80s");
  });

  it("returns null when there are no tags", () => {
    expect(formatTags([])).toBeNull();
    expect(formatTags(null)).toBeNull();
    expect(formatTags(undefined)).toBeNull();
  });
});

describe("nextCycleIndex", () => {
  it("wraps at the end", () => {
    expect(nextCycleIndex(0, 3)).toBe(1);
    expect(nextCycleIndex(2, 3)).toBe(0);
  });

  it("stays at 0 for empty or single-item sets", () => {
    expect(nextCycleIndex(0, 0)).toBe(0);
    expect(nextCycleIndex(5, 0)).toBe(0);
    expect(nextCycleIndex(0, 1)).toBe(0);
  });
});
