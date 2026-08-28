import { describe, it, expect } from "vitest";
import {
  isNowPlayingItemSelected,
  formatPlays,
  formatSource,
  formatQuality,
  formatEngineQuality,
  formatEngineVideoQuality,
  resolutionShorthand,
  formatTags,
  nextCycleIndex,
  nowPlayingItemTop,
  nowPlayingSteadyOrder,
  nowPlayingItemStyle,
  nowPlayingStyleClass,
  nowPlayingOrderedItems,
  isValidNowPlayingTop,
  NOW_PLAYING_TOP_PRESETS,
  NOW_PLAYING_TOP_REQUEST,
  NOW_PLAYING_SCROBBLES_ID,
  type NowPlayingInfoDescriptor,
  type NowPlayingInfoResolved,
} from "../hooks/useNowPlayingInfo";
import { NOW_PLAYING_DWELL_OPTIONS, parseDwellValue } from "../components/NowPlayingInfoSettings";
import {
  initialCycleState,
  nowPlayingRequestSig,
  trackOnRequestItems,
  type NowPlayingCycleState,
} from "../components/NowPlayingInfoCycler";

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
  it("shows codec + sample rate + bit depth for the unambiguous sample formats", () => {
    expect(formatEngineQuality({ codec: "flac", sampleRate: 44100, format: "s16", bitrate: null }))
      .toBe("FLAC · 44.1 kHz · 16-bit");
  });

  // `audio-params/format` is the decoder's output, not the file's depth: a
  // 24-bit FLAC decodes to s32 (measured against real libmpv), and every lossy
  // codec decodes to float. Claiming a depth from either is a wrong number in
  // the one field a hi-res listener is reading — the sample rate must survive
  // it, which is what the old rate-hangs-off-depth branch got wrong.
  it("states no bit depth for the wide formats, and keeps the sample rate", () => {
    expect(formatEngineQuality({ codec: "flac", sampleRate: 96000, format: "s32", bitrate: 4231000 }))
      .toBe("FLAC · 96.0 kHz · 4231 kbps");
    expect(formatEngineQuality({ codec: "flac", sampleRate: 96000, format: "s32", bitrate: null }))
      .toBe("FLAC · 96.0 kHz");
    expect(formatEngineQuality({ codec: "aac", sampleRate: 48000, format: "floatp", bitrate: 128000 }))
      .toBe("AAC · 48.0 kHz · 128 kbps");
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

describe("resolutionShorthand", () => {
  it("maps standard heights to tier labels", () => {
    expect(resolutionShorthand(3840, 2160)).toBe("4K");
    expect(resolutionShorthand(2560, 1440)).toBe("1440p");
    expect(resolutionShorthand(1920, 1080)).toBe("1080p");
    expect(resolutionShorthand(1280, 720)).toBe("720p");
    expect(resolutionShorthand(854, 480)).toBe("480p");
    expect(resolutionShorthand(7680, 4320)).toBe("8K");
  });

  it("snaps slightly-cropped heights to the nearest tier", () => {
    expect(resolutionShorthand(1920, 1072)).toBe("1080p");
    expect(resolutionShorthand(3840, 2140)).toBe("4K");
  });

  it("uses width as a fallback tier signal and falls back to `${h}p`", () => {
    expect(resolutionShorthand(3840, 0)).toBe("4K");
    expect(resolutionShorthand(0, 300)).toBe("300p");
  });

  it("returns null when nothing is known", () => {
    expect(resolutionShorthand(null, null)).toBeNull();
    expect(resolutionShorthand(0, 0)).toBeNull();
  });
});

describe("formatEngineVideoQuality", () => {
  it("shows codec + resolution shorthand + fps", () => {
    expect(formatEngineVideoQuality({ videoCodec: "h264", width: 1920, height: 1080, fps: 30 }))
      .toBe("H264 · 1080p · 30fps");
    expect(formatEngineVideoQuality({ videoCodec: "vp9", width: 3840, height: 2160, fps: 59.94 }))
      .toBe("VP9 · 4K · 60fps");
  });

  it("omits missing parts", () => {
    expect(formatEngineVideoQuality({ videoCodec: "av1", width: null, height: null, fps: null }))
      .toBe("AV1");
    expect(formatEngineVideoQuality({ videoCodec: null, width: 1280, height: 720, fps: null }))
      .toBe("720p");
  });

  it("returns null for audio-only / no info", () => {
    expect(formatEngineVideoQuality(null)).toBeNull();
    expect(formatEngineVideoQuality({ videoCodec: null, width: null, height: null, fps: null })).toBeNull();
    // Audio-only engine info (no video fields) → null.
    expect(formatEngineVideoQuality({ videoCodec: null, width: 0, height: 0, fps: 0 })).toBeNull();
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
    expect(nowPlayingItemTop("builtin:lyrics-synced", {})).toBe(NOW_PLAYING_TOP_REQUEST);
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

  it("accepts the on-request sentinel as a stored override", () => {
    expect(nowPlayingItemTop("x", { x: NOW_PLAYING_TOP_REQUEST })).toBe(NOW_PLAYING_TOP_REQUEST);
    expect(isValidNowPlayingTop(NOW_PLAYING_TOP_REQUEST)).toBe(true);
  });

  it("falls back to the built-in default (or 1) for values that aren't allowed presets", () => {
    expect(nowPlayingItemTop("x", { x: 3 })).toBe(1);
    expect(nowPlayingItemTop("x", { x: 7 })).toBe(1);
    expect(nowPlayingItemTop("x", { x: -2 })).toBe(1);
    expect(nowPlayingItemTop("builtin:lyrics-synced", { "builtin:lyrics-synced": 3 })).toBe(NOW_PLAYING_TOP_REQUEST);
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
  it("keeps the display (priority) order — ToP is dwell time, not rank", () => {
    const out = nowPlayingSteadyOrder([
      { id: "a", top: 1 },
      { id: "b", top: 10 },
      { id: "c", top: 2 },
    ]);
    expect(out.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("drops preview-only items (top === 0)", () => {
    const out = nowPlayingSteadyOrder([
      { id: "a", top: 0 },
      { id: "b", top: 5 },
      { id: "c", top: 0 },
    ]);
    expect(out.map((i) => i.id)).toEqual(["b"]);
  });

  it("treats a missing top as 1 (kept, not dropped)", () => {
    const out = nowPlayingSteadyOrder([
      { id: "a" },
      { id: "b", top: 5 },
    ]);
    expect(out.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("drops on-request items — they appear only by preempting", () => {
    const out = nowPlayingSteadyOrder([
      { id: "a", top: NOW_PLAYING_TOP_REQUEST },
      { id: "b", top: 1 },
    ]);
    expect(out.map((i) => i.id)).toEqual(["b"]);
  });
});

describe("nowPlayingOrderedItems", () => {
  const REG = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("returns registration order when there is no saved order", () => {
    expect(nowPlayingOrderedItems(REG, []).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("applies the user's priority order", () => {
    expect(nowPlayingOrderedItems(REG, ["c", "a", "d", "b"]).map((i) => i.id)).toEqual(["c", "a", "d", "b"]);
  });

  it("appends unlisted items (newly registered) after the ordered ones, in registration order", () => {
    expect(nowPlayingOrderedItems(REG, ["d", "b"]).map((i) => i.id)).toEqual(["d", "b", "a", "c"]);
  });

  it("ignores ordered ids that are no longer registered (uninstalled plugin)", () => {
    expect(nowPlayingOrderedItems(REG, ["gone:item", "c"]).map((i) => i.id)).toEqual(["c", "a", "b", "d"]);
  });
});


describe("dwell select (Off folded into the presets)", () => {
  it("offers Off first, then every ToP preset", () => {
    expect(NOW_PLAYING_DWELL_OPTIONS.map((o) => o.value)).toEqual(["off", "0", "-1", "1", "2", "5", "10"]);
    expect(NOW_PLAYING_DWELL_OPTIONS.map((o) => o.label)).toEqual([
      "Off", "Preview only", "On request", "1×", "2×", "5×", "10×",
    ]);
  });

  it("parses Off as null and presets as their multiplier", () => {
    expect(parseDwellValue("off")).toBeNull();
    expect(parseDwellValue("0")).toBe(0);
    expect(parseDwellValue("1")).toBe(1);
    expect(parseDwellValue("10")).toBe(10);
    expect(parseDwellValue("-1")).toBe(NOW_PLAYING_TOP_REQUEST);
  });

  it("treats an unknown value as off rather than an invalid dwell", () => {
    expect(parseDwellValue("3")).toBeNull();
    expect(parseDwellValue("")).toBeNull();
  });

  it("round-trips every option through the parser", () => {
    for (const o of NOW_PLAYING_DWELL_OPTIONS) {
      const parsed = parseDwellValue(o.value);
      expect(o.value === "off" ? parsed === null : String(parsed) === o.value).toBe(true);
    }
  });
});

describe("trackOnRequestItems", () => {
  const item = (id: string, text: string, top: number = NOW_PLAYING_TOP_REQUEST): NowPlayingInfoResolved =>
    ({ id, segments: [{ text }], top });
  const seeded = (seen: Record<string, string>): NowPlayingCycleState =>
    ({ ...initialCycleState(), reqSeen: seen });

  it("seeds the first list after a track change without raising a request", () => {
    const s0 = initialCycleState();
    const out = trackOnRequestItems([item("lyr", "line one")], s0, 1000);
    expect(out.request).toBeNull();
    expect(out.reqSeen).toEqual({ lyr: "line one" });
  });

  it("raises a request when a seeded item's content changes", () => {
    const s = seeded({ lyr: "line one" });
    const out = trackOnRequestItems([item("lyr", "line two")], s, 2000);
    expect(out.request).toEqual({ id: "lyr", sig: "line two", at: 2000 });
    expect(out.reqSeen).toEqual({ lyr: "line two" });
  });

  it("raises a request when an item appears after being absent (intro ends)", () => {
    const s = seeded({});
    const out = trackOnRequestItems([item("lyr", "first line")], s, 3000);
    expect(out.request).toEqual({ id: "lyr", sig: "first line", at: 3000 });
  });

  it("drops a live request when its item vanishes (the sung line ended)", () => {
    const s: NowPlayingCycleState = {
      ...seeded({ lyr: "line one" }),
      request: { id: "lyr", sig: "line one", at: 1000 },
    };
    const out = trackOnRequestItems([], s, 2000);
    expect(out.request).toBeNull();
  });

  it("lets the last changed item win when several change in one pass", () => {
    const s = seeded({ a: "old a", b: "old b" });
    const out = trackOnRequestItems([item("a", "new a"), item("b", "new b")], s, 5000);
    expect(out.request).toEqual({ id: "b", sig: "new b", at: 5000 });
    expect(out.reqSeen).toEqual({ a: "new a", b: "new b" });
  });

  it("ignores rotation items — only top === NOW_PLAYING_TOP_REQUEST participates", () => {
    const s = seeded({});
    const out = trackOnRequestItems([item("rot", "changed", 5)], s, 4000);
    expect(out.request).toBeNull();
    expect(out.reqSeen).toEqual({});
  });

  it("returns the same state object when nothing changed (React bail-out)", () => {
    const s = seeded({ lyr: "line one" });
    expect(trackOnRequestItems([item("lyr", "line one")], s, 9000)).toBe(s);
  });

  it("keeps an unexpired request alive while its item's content holds still", () => {
    const s: NowPlayingCycleState = {
      ...seeded({ lyr: "line one" }),
      request: { id: "lyr", sig: "line one", at: 1000 },
    };
    expect(trackOnRequestItems([item("lyr", "line one")], s, 2000)).toBe(s);
  });

  it("joins multi-segment content into one signature", () => {
    expect(nowPlayingRequestSig({ id: "x", segments: [{ text: "a" }, { text: "b" }] })).toBe("a|b");
  });
});
