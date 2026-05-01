import { describe, it, expect } from "vitest";
import type { Track } from "../types";
import {
  buildManifest,
  buildState,
  contextFromManifest,
  diffThumbs,
  thumbFilenameForUri,
  type Manifest,
} from "../mainPlaylist";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: null, key: "ext:1", path: "file:///x.mp3", title: "T",
    artist_id: null, artist_name: "A", album_id: null, album_title: "Al",
    year: null, track_number: null, duration_secs: 200, format: "mp3",
    file_size: null, collection_id: null, collection_name: null,
    liked: 0, youtube_url: null, added_at: null, modified_at: null,
    image_url: undefined, ...overrides,
  };
}

describe("buildManifest", () => {
  it("produces a version-1 custom mixtape manifest", () => {
    const t = makeTrack();
    const m = buildManifest([t], { name: "Hits" });
    expect(m.version).toBe(1);
    expect(m.type).toBe("custom");
    expect(m.title).toBe("Hits");
    expect(m.tracks).toHaveLength(1);
    expect(m.tracks[0].file).toBe("file:///x.mp3");
  });

  it("references thumbs/{slug}.jpg derived from the track URI when context source is spotify", () => {
    const t = makeTrack({ path: "tidal://12345" });
    const m = buildManifest([t], { name: "P", source: "spotify" });
    expect(m.tracks[0].thumb).toBe("thumbs/tidal12345.jpg");
  });

  it("leaves thumb null when context source is library", () => {
    const m = buildManifest([makeTrack()], { name: "P", source: "library" });
    expect(m.tracks[0].thumb).toBeNull();
  });

  it("sets cover to 'cover.jpg' when context has an image", () => {
    const m = buildManifest([], { name: "P", imagePath: "/abs/x.jpg" });
    expect(m.cover).toBe("cover.jpg");
  });
});

describe("buildState", () => {
  it("round-trips queue playback state", () => {
    const s = buildState(3, "shuffle", [0, 2, 1], 1);
    expect(s).toEqual({ queueIndex: 3, queueMode: "shuffle", shuffleOrder: [0, 2, 1], shufflePosition: 1 });
  });
});

describe("diffThumbs", () => {
  it("returns added and removed by URI", () => {
    const a = [makeTrack({ path: "spotify://a" }), makeTrack({ path: "spotify://b" })];
    const b = [makeTrack({ path: "spotify://a" }), makeTrack({ path: "spotify://c" })];
    const d = diffThumbs(a, b);
    expect(d.added.map(t => t.path)).toEqual(["spotify://c"]);
    expect(d.removed).toEqual(["spotify://b"]);
  });

  it("returns empty on reorder", () => {
    const a = [makeTrack({ path: "spotify://a" }), makeTrack({ path: "spotify://b" })];
    const b = [makeTrack({ path: "spotify://b" }), makeTrack({ path: "spotify://a" })];
    const d = diffThumbs(a, b);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
  });
});

describe("contextFromManifest", () => {
  it("resolves imagePath to absolute path when manifest has cover and dir is provided", () => {
    const m: Manifest = {
      version: 1,
      title: "P",
      type: "custom",
      metadata: { source: "spotify" },
      created_at: "2026-05-01T00:00:00Z",
      created_by: null,
      cover: "cover.jpg",
      tracks: [],
    };
    const ctx = contextFromManifest(m, "/profile/main-playlist");
    expect(ctx?.imagePath).toBe("/profile/main-playlist/cover.jpg");
    expect(ctx?.source).toBe("spotify");
  });

  it("leaves imagePath null when dir is unknown", () => {
    const m: Manifest = {
      version: 1,
      title: "P",
      type: "custom",
      metadata: {},
      created_at: "2026-05-01T00:00:00Z",
      created_by: null,
      cover: "cover.jpg",
      tracks: [],
    };
    const ctx = contextFromManifest(m, null);
    expect(ctx?.imagePath).toBeNull();
  });

  it("returns context with source metadata", () => {
    const m: Manifest = {
      version: 1,
      title: "P",
      type: "custom",
      metadata: { source: "spotify" },
      created_at: "2026-05-01T00:00:00Z",
      created_by: null,
      cover: null,
      tracks: [],
    };
    const ctx = contextFromManifest(m, null);
    expect(ctx?.source).toBe("spotify");
  });

  it("returns context with library source", () => {
    const m: Manifest = {
      version: 1,
      title: "P",
      type: "custom",
      metadata: { source: "library" },
      created_at: "2026-05-01T00:00:00Z",
      created_by: null,
      cover: null,
      tracks: [],
    };
    const ctx = contextFromManifest(m, null);
    expect(ctx?.source).toBe("library");
  });
});

describe("thumbFilenameForUri", () => {
  it("matches backend canonical_slug: colons and slashes are deleted", () => {
    expect(thumbFilenameForUri("tidal://12345")).toBe("tidal12345.jpg");
    expect(thumbFilenameForUri("spotify://abc")).toBe("spotifyabc.jpg");
  });

  it("falls back to _unknown for empty strings", () => {
    expect(thumbFilenameForUri("")).toBe("_unknown.jpg");
    expect(thumbFilenameForUri(null as unknown as string)).toBe("_unknown.jpg");
  });
});
