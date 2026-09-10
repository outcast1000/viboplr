// Pins the control API dispatcher's pure logic (utils/controlApi.ts) — the
// validation and decision rules the HTTP surface depends on. Mirrors
// probeControl.test.ts: no webview, no invoke, just the contracts.
import { describe, it, expect } from "vitest";
import {
  parseControlRequest,
  clampVolume,
  decidePlayPause,
  validateIndices,
  asNumberArray,
  asStringArray,
  orderTracksByIds,
  partitionEnqueue,
  serializeQueue,
  serializeStatus,
  parseLikeState,
  parsePlaybackSet,
  resolveSkin,
  resolveSearchProvider,
  selectSearchTracks,
  resolveHomeShelf,
  serializeShelfItem,
  summarizeCapabilities,
  describeContributes,
  annotateGalleryPlugins,
  annotateGallerySkins,
} from "../utils/controlApi";
import type { QueueTrack, Track } from "../types";
import type { PluginManifestContributes } from "../types/plugin";

function qt(overrides: Partial<QueueTrack> = {}): QueueTrack {
  return {
    key: "ext:1",
    path: "file:///a.mp3",
    title: "Song",
    artist_name: "Artist",
    album_title: "Album",
    duration_secs: 200,
    format: "mp3",
    liked: 0,
    ...overrides,
  };
}

describe("parseControlRequest", () => {
  it("accepts a well-formed request and defaults a missing payload", () => {
    expect(parseControlRequest({ id: 3, verb: "status" })).toEqual({ id: 3, verb: "status", payload: {} });
    expect(parseControlRequest({ id: 3, verb: "queue.add", payload: { trackIds: [1] } }))
      .toEqual({ id: 3, verb: "queue.add", payload: { trackIds: [1] } });
  });

  it("rejects malformed shapes rather than throwing", () => {
    expect(parseControlRequest(null)).toBeNull();
    expect(parseControlRequest("nope")).toBeNull();
    expect(parseControlRequest({ verb: "status" })).toBeNull();
    expect(parseControlRequest({ id: "3", verb: "status" })).toBeNull();
    // An array payload is not an object payload.
    expect(parseControlRequest({ id: 1, verb: "x", payload: [1] })).toEqual({ id: 1, verb: "x", payload: {} });
  });
});

describe("decidePlayPause", () => {
  it("is idempotent — toggling only when the desired state differs", () => {
    expect(decidePlayPause(true, false)).toBe("toggle");
    expect(decidePlayPause(false, true)).toBe("toggle");
    expect(decidePlayPause(true, true)).toBe("noop");
    expect(decidePlayPause(false, false)).toBe("noop");
  });
});

describe("clampVolume", () => {
  it("clamps to [0, 1] and defuses non-finite input", () => {
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(2)).toBe(1);
    expect(clampVolume(NaN)).toBe(1);
    expect(clampVolume(Infinity)).toBe(1);
  });
});

describe("validateIndices", () => {
  it("accepts in-range indices and dedupes them", () => {
    expect(validateIndices([0, 2, 2, 1], 3)).toEqual([0, 2, 1]);
  });

  it("names the out-of-range index in the error", () => {
    const err = validateIndices([0, 5], 3);
    expect(typeof err).toBe("string");
    expect(err).toContain("5");
  });

  it("rejects empty, non-array, non-integer and negative input", () => {
    expect(typeof validateIndices([], 3)).toBe("string");
    expect(typeof validateIndices("0", 3)).toBe("string");
    expect(typeof validateIndices([0.5], 3)).toBe("string");
    expect(typeof validateIndices([-1], 3)).toBe("string");
  });
});

describe("asNumberArray / asStringArray", () => {
  it("asNumberArray accepts only non-empty all-number arrays", () => {
    expect(asNumberArray([1, 2])).toEqual([1, 2]);
    expect(asNumberArray([])).toBeNull();
    expect(asNumberArray([1, "2"])).toBeNull();
    expect(asNumberArray([NaN])).toBeNull();
    expect(asNumberArray("1")).toBeNull();
  });

  it("asStringArray keeps only non-empty strings", () => {
    expect(asStringArray(["a", "", 1, "b"])).toEqual(["a", "b"]);
    expect(asStringArray(undefined)).toEqual([]);
  });
});

describe("orderTracksByIds", () => {
  it("reorders to the request order and drops unresolved ids", () => {
    const tracks = [{ id: 1 }, { id: 2 }, { id: 3 }] as Track[];
    const ordered = orderTracksByIds(tracks, [3, 99, 1]);
    expect(ordered.map((t) => t.id)).toEqual([3, 1]);
  });
});

describe("partitionEnqueue", () => {
  const all = [qt({ key: "a" }), qt({ key: "b", path: "file:///b.mp3" })];
  const dup = { duplicates: [all[0]], unique: [all[1]] };

  it("skips duplicates by default and reports the count", () => {
    expect(partitionEnqueue(all, dup, false)).toEqual({ toAdd: [all[1]], skipped: 1 });
  });

  it("adds everything when the caller allowed duplicates", () => {
    expect(partitionEnqueue(all, dup, true)).toEqual({ toAdd: all, skipped: 0 });
  });
});

describe("serializeQueue / serializeStatus", () => {
  it("marks the current row and keeps index/mode", () => {
    const out = serializeQueue([qt(), qt({ key: "ext:2", title: "Two" })], 1, "repeat-all");
    expect(out.index).toBe(1);
    expect(out.mode).toBe("repeat-all");
    expect(out.tracks.map((t) => t.current)).toEqual([false, true]);
    expect(out.tracks[1]).toMatchObject({ index: 1, title: "Two", artistName: "Artist" });
  });

  it("carries the entry's libraryId, and null when it has none", () => {
    const out = serializeQueue([qt({ libraryId: 42 }), qt({})], 0, "normal");
    expect(out.tracks.map((t) => t.libraryId)).toEqual([42, null]);
    const status = serializeStatus({
      playing: false, positionSecs: 0, durationSecs: null, volume: 1, muted: false,
      queueLength: 1, queueIndex: 0, queueMode: "normal", view: "home",
      currentTrack: qt({ libraryId: 42 }),
    });
    expect(status.currentTrack?.libraryId).toBe(42);
  });

  // The id must come from the field, never from the key: a re-keyed copy of a
  // library track (`withUniqueKeys`) keeps `libraryId` but carries a re-minted `q:N`
  // key, and every restored entry does too.
  it("reads the id from libraryId, not from a lib: key", () => {
    const out = serializeQueue(
      [qt({ key: "ext:7", libraryId: 42 }), qt({ key: "lib:9", libraryId: null })],
      0,
      "normal",
    );
    expect(out.tracks.map((t) => t.libraryId)).toEqual([42, null]);
  });

  it("serializes a null current track and a full one", () => {
    const base = {
      playing: true, positionSecs: 12.5, durationSecs: 200, volume: 0.8, muted: false,
      queueLength: 2, queueIndex: 0, queueMode: "normal" as const, view: "home",
    };
    expect(serializeStatus({ ...base, currentTrack: null }).currentTrack).toBeNull();
    const withTrack = serializeStatus({ ...base, currentTrack: qt() });
    expect(withTrack.currentTrack).toMatchObject({ title: "Song", artistName: "Artist", liked: 0 });
    expect(withTrack.playing).toBe(true);
    expect(withTrack.positionSecs).toBe(12.5);
  });
});

describe("resolveSearchProvider", () => {
  const providers = [
    { pluginId: "ytdlp", providerId: "youtube", name: "YouTube" },
    { pluginId: "spotify-browse", providerId: "catalog", name: "Spotify" },
    { pluginId: "tidal", providerId: "catalog", name: "TIDAL" },
  ];

  it("matches the full key, then unambiguous shorthand or name", () => {
    expect(resolveSearchProvider(providers, "ytdlp:youtube")).toBe(providers[0]);
    expect(resolveSearchProvider(providers, "youtube")).toBe(providers[0]);
    expect(resolveSearchProvider(providers, "spotify-browse")).toBe(providers[1]);
    expect(resolveSearchProvider(providers, "tidal")).toBe(providers[2]);
    expect(resolveSearchProvider(providers, "SPOTIFY")).toBe(providers[1]);
  });

  it("names the ambiguity and the roster in errors", () => {
    const ambiguous = resolveSearchProvider(providers, "catalog");
    expect(typeof ambiguous).toBe("string");
    expect(ambiguous).toContain("spotify-browse:catalog");
    expect(ambiguous).toContain("tidal:catalog");
    const missing = resolveSearchProvider(providers, "zzz");
    expect(typeof missing).toBe("string");
    expect(missing).toContain("ytdlp:youtube");
  });
});

describe("selectSearchTracks", () => {
  const tracks = [qt({ key: "a" }), qt({ key: "b" }), qt({ key: "c" })];

  it("returns all tracks when indices are omitted", () => {
    expect(selectSearchTracks(tracks, undefined)).toEqual(tracks);
  });

  it("picks by index and rejects out-of-range", () => {
    expect(selectSearchTracks(tracks, [2, 0])).toEqual([tracks[2], tracks[0]]);
    expect(typeof selectSearchTracks(tracks, [3])).toBe("string");
    expect(typeof selectSearchTracks(tracks, [])).toBe("string");
  });
});

describe("resolveHomeShelf", () => {
  const shelves = [
    { pluginId: "spotify-browse", shelfId: "made-for-you", title: "Made For You" },
    { pluginId: "spotify-browse", shelfId: "daily-mixes", title: "Daily Mixes" },
  ];

  it("matches full key, unambiguous shelfId or title", () => {
    expect(resolveHomeShelf(shelves, "spotify-browse:daily-mixes")).toBe(shelves[1]);
    expect(resolveHomeShelf(shelves, "daily-mixes")).toBe(shelves[1]);
    expect(resolveHomeShelf(shelves, "made for you")).toBe(shelves[0]);
  });

  it("reports ambiguity (shared pluginId) and misses with the roster", () => {
    const ambiguous = resolveHomeShelf(shelves, "spotify-browse");
    expect(typeof ambiguous).toBe("string");
    expect(ambiguous).toContain("daily-mixes");
    expect(typeof resolveHomeShelf(shelves, "zzz")).toBe("string");
  });
});

describe("serializeShelfItem", () => {
  it("summarizes a playlist card, marking partial and lazy ones playable", () => {
    const full = serializeShelfItem("playlist-cards", { id: "p1", name: "Mix", tracks: [{ title: "A" }] } as never, 0);
    expect(full).toMatchObject({ index: 0, name: "Mix", playable: true, shippedTracks: 1, partial: false });
    const lazy = serializeShelfItem("playlist-cards", { id: "p2", name: "Lazy", tracks: [] } as never, 1);
    expect(lazy.playable).toBe(true); // resolver may fill it at play time
    expect(lazy.shippedTracks).toBe(0);
    const partial = serializeShelfItem("playlist-cards", { id: "p3", name: "Radio", tracks: [{ title: "Seed" }], partial: true } as never, 2);
    expect(partial.partial).toBe(true);
  });

  it("names track rows by their track and artist cards by libraryId playability", () => {
    const row = serializeShelfItem("track-rows", { track: { title: "Song", artist_name: "Artist" } } as never, 0);
    expect(row).toMatchObject({ name: "Song", subtitle: "Artist", playable: true, shippedTracks: 1 });
    const artist = serializeShelfItem("artist-cards", { name: "Nirvana", libraryId: 3 } as never, 0);
    expect(artist).toMatchObject({ name: "Nirvana", playable: true, libraryId: 3 });
    const external = serializeShelfItem("artist-cards", { name: "Nobody" } as never, 1);
    expect(external.playable).toBe(false);
  });
});

describe("resolveSkin", () => {
  const skins = [
    { id: "default", name: "Default" },
    { id: "midnight-blue", name: "Midnight Blue" },
  ];

  it("matches by id first, then case-insensitive name", () => {
    expect(resolveSkin(skins, "midnight-blue")?.id).toBe("midnight-blue");
    expect(resolveSkin(skins, "MIDNIGHT blue")?.id).toBe("midnight-blue");
    expect(resolveSkin(skins, "Default")?.id).toBe("default");
    expect(resolveSkin(skins, "nope")).toBeNull();
  });
});

describe("parseLikeState", () => {
  it("accepts exactly the tri-state values", () => {
    expect(parseLikeState(-1)).toBe(-1);
    expect(parseLikeState(0)).toBe(0);
    expect(parseLikeState(1)).toBe(1);
    expect(parseLikeState(2)).toBeNull();
    expect(parseLikeState("1")).toBeNull();
    expect(parseLikeState(undefined)).toBeNull();
  });
});

describe("parsePlaybackSet", () => {
  it("rejects an empty payload — a caller bug worth surfacing", () => {
    expect(typeof parsePlaybackSet({})).toBe("string");
  });

  it("accepts and clamps the valid fields", () => {
    expect(parsePlaybackSet({ play: true, volume: 1.5, seekSecs: 30 }))
      .toEqual({ play: true, volume: 1, seekSecs: 30 });
    expect(parsePlaybackSet({ action: "next" })).toEqual({ action: "next" });
  });

  it("rejects wrong types field by field", () => {
    expect(typeof parsePlaybackSet({ play: "yes" })).toBe("string");
    expect(typeof parsePlaybackSet({ action: "skip" })).toBe("string");
    expect(typeof parsePlaybackSet({ seekSecs: -1 })).toBe("string");
    expect(typeof parsePlaybackSet({ volume: "loud" })).toBe("string");
  });

  it("accepts exactly the three queue modes", () => {
    expect(parsePlaybackSet({ mode: "repeat-all" })).toEqual({ mode: "repeat-all" });
    expect(parsePlaybackSet({ mode: "repeat-one" })).toEqual({ mode: "repeat-one" });
    expect(parsePlaybackSet({ mode: "normal" })).toEqual({ mode: "normal" });
    expect(typeof parsePlaybackSet({ mode: "shuffle" })).toBe("string");
    expect(typeof parsePlaybackSet({ mode: 1 })).toBe("string");
  });
});

// --- Extension capabilities + gallery ---------------------------------------

const YTDLP_CONTRIBUTES: PluginManifestContributes = {
  sidebarItems: [{ id: "ytdlp-view", label: "yt-dlp", icon: "video" }],
  contextMenuItems: [{ id: "watch-youtube", label: "Watch YouTube video", targets: ["track"] }],
  streamResolvers: [{ id: "ytdlp-resolver", name: "yt-dlp" }],
  downloadProviders: [{ id: "ytdlp-download", name: "yt-dlp" }],
  settingsPanel: { id: "ytdlp-settings", label: "yt-dlp" },
};

describe("summarizeCapabilities", () => {
  it("counts runtime-capable kinds from the live lists, manifest-only kinds from the declaration", () => {
    // yt-dlp declares no searchProviders in its manifest (its provider is
    // runtime-registered, gated on the binary) — the live count must win.
    const out = summarizeCapabilities(YTDLP_CONTRIBUTES, {
      searchProviders: 1, homeShelves: 0, contextMenuItems: 1,
    });
    expect(out).toEqual({
      searchProviders: 1,
      contextMenuItems: 1,
      downloadProviders: 1,
      streamResolvers: 1,
      sidebarViews: 1,
      settingsPanel: true,
    });
  });

  it("omits zero-valued keys entirely and tolerates a missing contributes block", () => {
    expect(summarizeCapabilities(undefined, { searchProviders: 0, homeShelves: 0, contextMenuItems: 0 }))
      .toEqual({});
    expect(summarizeCapabilities({}, { searchProviders: 0, homeShelves: 2, contextMenuItems: 0 }))
      .toEqual({ homeShelves: 2 });
  });
});

describe("describeContributes", () => {
  it("reshapes declarations to agent-relevant fields and always emits every key", () => {
    const out = describeContributes(YTDLP_CONTRIBUTES);
    expect(out.contextMenuItems).toEqual([{ id: "watch-youtube", label: "Watch YouTube video", targets: ["track"] }]);
    expect(out.downloadProviders).toEqual([{ id: "ytdlp-download", name: "yt-dlp" }]);
    expect(out.settingsPanel).toEqual({ id: "ytdlp-settings", label: "yt-dlp" });
    // Undeclared kinds are empty lists, not missing keys — an agent reads a
    // stable shape.
    expect(out.searchProviders).toEqual([]);
    expect(out.homeShelves).toEqual([]);
    expect(describeContributes(undefined).eventHooks).toEqual([]);
  });
});

describe("annotateGalleryPlugins", () => {
  const entries = [
    { id: "ytdlp", name: "yt-dlp", author: "Viboplr", description: "1000+ sites", recommended: true },
    { id: "qbittorrent", name: "qBittorrent", author: "Viboplr", description: "Torrents", stability: "experimental" },
  ];

  it("marks installed entries with their installed version and enabled state", () => {
    const out = annotateGalleryPlugins(entries, [
      { id: "ytdlp", enabled: true, manifest: { version: "1.7.0" } },
    ]);
    expect(out[0]).toMatchObject({ id: "ytdlp", installed: true, installedVersion: "1.7.0", enabled: true, recommended: true });
    expect(out[1]).toMatchObject({ id: "qbittorrent", installed: false, installedVersion: null, enabled: null });
  });

  it("normalizes stability through the shared classifier (unrecognized = experimental)", () => {
    const out = annotateGalleryPlugins(
      [{ id: "a", name: "A", author: "x", description: "" },
       { id: "b", name: "B", author: "x", description: "", stability: "weird" }],
      [],
    );
    expect(out[0].stability).toBe("stable");
    expect(out[1].stability).toBe("experimental");
  });
});

describe("annotateGallerySkins", () => {
  it("marks installed skins by id or case-insensitive name, and the active one", () => {
    const entries = [
      { id: "midnight", name: "Midnight", author: "x", type: "dark" as const, version: "1.0", file: "m.json", colors: ["#000", "#111", "#222", "#333"] as [string, string, string, string] },
      { id: "paper", name: "Paper", author: "x", type: "light" as const, version: "1.0", file: "p.json", colors: ["#fff", "#eee", "#ddd", "#ccc"] as [string, string, string, string] },
    ];
    const out = annotateGallerySkins(entries, [{ id: "midnight", name: "Midnight" }], "midnight");
    expect(out[0]).toMatchObject({ id: "midnight", installed: true, active: true });
    expect(out[1]).toMatchObject({ id: "paper", installed: false, active: false });
    // The raw gallery fields an agent can't use (file, colors) are dropped.
    expect(out[0]).not.toHaveProperty("file");
  });
});
