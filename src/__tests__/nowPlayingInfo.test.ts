import { describe, it, expect } from "vitest";
import {
  isNowPlayingItemSelected,
  formatPlays,
  formatSource,
  formatQuality,
  formatEngineQuality,
  formatTags,
  nextCycleIndex,
  nowPlayingItemTop,
  nowPlayingSteadyOrder,
  nowPlayingItemStyle,
  nowPlayingStyleClass,
  NOW_PLAYING_TOP_PRESETS,
  NOW_PLAYING_SCROBBLES_ID,
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

describe("formatEngineQuality", () => {
  it("shows codec + sample rate + bit depth from mpv sample formats", () => {
    expect(formatEngineQuality({ codec: "flac", sampleRate: 44100, format: "s16", bitrate: null }))
      .toBe("FLAC · 44.1 kHz · 16-bit");
    expect(formatEngineQuality({ codec: "flac", sampleRate: 96000, format: "s32", bitrate: null }))
      .toBe("FLAC · 96.0 kHz · 32-bit");
    expect(formatEngineQuality({ codec: "aac", sampleRate: 48000, format: "floatp", bitrate: null }))
      .toBe("AAC · 48.0 kHz · 32-bit float");
  });

  it("falls back to bitrate when the sample format is unknown", () => {
    expect(formatEngineQuality({ codec: "mp3", sampleRate: null, format: null, bitrate: 320000 }))
      .toBe("MP3 · 320 kbps");
  });

  it("falls back to sample rate alone", () => {
    expect(formatEngineQuality({ codec: "vorbis", sampleRate: 44100, format: "weird", bitrate: null }))
      .toBe("VORBIS · 44.1 kHz");
  });

  it("returns null for no info / empty info", () => {
    expect(formatEngineQuality(null)).toBeNull();
    expect(formatEngineQuality({ codec: null, sampleRate: null, format: null, bitrate: null })).toBeNull();
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

describe("nowPlayingItemTop", () => {
  it("defaults to 1 for an item with no built-in default and no stored value", () => {
    expect(nowPlayingItemTop("builtin:artist-album", {})).toBe(1);
  });

  it("uses each item's built-in default when there's no stored value", () => {
    expect(nowPlayingItemTop("builtin:lyrics-synced", {})).toBe(5);
    expect(nowPlayingItemTop(NOW_PLAYING_SCROBBLES_ID, {})).toBe(0);
  });

  it("lets a valid stored override beat the built-in default", () => {
    expect(nowPlayingItemTop("builtin:lyrics-synced", { "builtin:lyrics-synced": 2 })).toBe(2);
    expect(nowPlayingItemTop(NOW_PLAYING_SCROBBLES_ID, { [NOW_PLAYING_SCROBBLES_ID]: 10 })).toBe(10);
  });

  it("returns any of the allowed presets verbatim (including 0 = preview only)", () => {
    for (const p of NOW_PLAYING_TOP_PRESETS) {
      expect(nowPlayingItemTop("x", { x: p })).toBe(p);
    }
  });

  it("falls back to the built-in default (or 1) for values that aren't allowed presets", () => {
    expect(nowPlayingItemTop("x", { x: 3 })).toBe(1);
    expect(nowPlayingItemTop("x", { x: 7 })).toBe(1);
    expect(nowPlayingItemTop("x", { x: -1 })).toBe(1);
    expect(nowPlayingItemTop("builtin:lyrics-synced", { "builtin:lyrics-synced": 3 })).toBe(5);
  });

  it("includes 0 as a valid preset (preview-only)", () => {
    expect(NOW_PLAYING_TOP_PRESETS).toContain(0);
  });
});

describe("nowPlayingItemStyle", () => {
  it("italicizes the lyrics items", () => {
    expect(nowPlayingItemStyle("builtin:lyrics-synced")).toEqual({ italic: true });
    expect(nowPlayingItemStyle("builtin:lyrics-plain")).toEqual({ italic: true });
  });

  it("accents the play-stat items", () => {
    expect(nowPlayingItemStyle("builtin:plays-rank")).toEqual({ role: "accent" });
    expect(nowPlayingItemStyle(NOW_PLAYING_SCROBBLES_ID)).toEqual({ role: "accent" });
  });

  it("mutes secondary metadata items", () => {
    expect(nowPlayingItemStyle("builtin:source")).toEqual({ role: "muted" });
    expect(nowPlayingItemStyle("builtin:tags")).toEqual({ role: "muted" });
  });

  it("returns undefined (default style) for the primary identity items and unknowns", () => {
    expect(nowPlayingItemStyle("builtin:artist-album")).toBeUndefined();
    expect(nowPlayingItemStyle("builtin:artist")).toBeUndefined();
    expect(nowPlayingItemStyle("mystery:thing")).toBeUndefined();
  });
});

describe("nowPlayingStyleClass", () => {
  it("returns an empty string for the default (undefined) style", () => {
    expect(nowPlayingStyleClass(undefined)).toBe("");
  });

  it("maps each style property to its skin-token class", () => {
    expect(nowPlayingStyleClass({ italic: true })).toBe("npi--italic");
    expect(nowPlayingStyleClass({ role: "accent" })).toBe("npi--accent");
    expect(nowPlayingStyleClass({ role: "muted" })).toBe("npi--muted");
    expect(nowPlayingStyleClass({ bold: true })).toBe("npi--bold");
  });

  it("combines emphasis and role", () => {
    expect(nowPlayingStyleClass({ bold: true, italic: true, role: "accent" })).toBe("npi--bold npi--italic npi--accent");
  });
});

describe("nowPlayingSteadyOrder", () => {
  it("sorts by ToP descending (largest first)", () => {
    const out = nowPlayingSteadyOrder([
      { id: "a", top: 1 },
      { id: "b", top: 10 },
      { id: "c", top: 2 },
    ]);
    expect(out.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("drops preview-only items (top === 0)", () => {
    const out = nowPlayingSteadyOrder([
      { id: "a", top: 0 },
      { id: "b", top: 5 },
      { id: "c", top: 0 },
    ]);
    expect(out.map((i) => i.id)).toEqual(["b"]);
  });

  it("is stable for equal ToP — keeps original display order", () => {
    const out = nowPlayingSteadyOrder([
      { id: "a", top: 2 },
      { id: "b", top: 2 },
      { id: "c", top: 2 },
    ]);
    expect(out.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("treats a missing top as 1 (kept, not dropped)", () => {
    const out = nowPlayingSteadyOrder([
      { id: "a" },
      { id: "b", top: 5 },
    ]);
    expect(out.map((i) => i.id)).toEqual(["b", "a"]);
  });
});
