import { describe, it, expect, vi } from "vitest";
import type { Track } from "../types";
import {
  buildManifest,
  buildState,
  contextFromManifest,
  contextToExportMetadata,
  contextFromMixtapeMetadata,
  diffThumbs,
  flushMainPlaylist,
  queueItemLocalThumb,
  tracksFromManifest,
  type Manifest,
} from "../mainPlaylist";
import { nextExternalKey } from "../queueEntry";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: null, key: "ext:1", path: "file:///x.mp3", title: "T",
    artist_id: null, artist_name: "A", album_id: null, album_title: "Al",
    year: null, track_number: null, duration_secs: 200, format: "mp3",
    file_size: null, collection_id: null, collection_name: null,
    liked: 0, added_at: null, modified_at: null,
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

  it("always leaves thumb null — the main playlist no longer persists a thumb path", () => {
    // The on-disk thumb filename is derived from `file` (canonical_slug) by the
    // backend; gc()/restore key off that, so the manifest never stores a path.
    const remote = buildManifest([makeTrack({ path: "tidal://12345" })], { name: "P", source: "spotify" });
    expect(remote.tracks[0].thumb).toBeNull();
    const library = buildManifest([makeTrack()], { name: "P", source: "library" });
    expect(library.tracks[0].thumb).toBeNull();
  });

  it("sets cover to 'cover.jpg' when context has an image", () => {
    const m = buildManifest([], { name: "P", imagePath: "/abs/x.jpg" });
    expect(m.cover).toBe("cover.jpg");
  });
});

describe("buildState", () => {
  it("round-trips queue playback state", () => {
    const s = buildState(3, "repeat-all");
    expect(s).toEqual({ queueIndex: 3, queueMode: "repeat-all" });
  });
});

describe("flushMainPlaylist", () => {
  it("sends the same payload the debounced writer builds for the same state", async () => {
    const t = makeTrack();
    const ctx = { name: "Hits" };
    const invokeFn = vi.fn().mockResolvedValue(undefined);
    await flushMainPlaylist(true, [t], ctx, 0, "normal", invokeFn);
    expect(invokeFn).toHaveBeenCalledExactlyOnceWith("main_playlist_write", {
      manifest: buildManifest([t], ctx),
      stateData: buildState(0, "normal"),
    });
  });

  it("is a no-op before restore completes", async () => {
    const invokeFn = vi.fn();
    await flushMainPlaylist(false, [makeTrack()], null, 0, "normal", invokeFn);
    expect(invokeFn).not.toHaveBeenCalled();
  });

  it("propagates rejections instead of swallowing them", async () => {
    const invokeFn = vi.fn().mockRejectedValue(new Error("disk full"));
    await expect(
      flushMainPlaylist(true, [], null, -1, "normal", invokeFn)
    ).rejects.toThrow("disk full");
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

  it("returns null when metadata field omitted and no cover (Rust skip_serializing_if)", () => {
    const m = {
      version: 1 as const,
      title: "Queue",
      type: "custom" as const,
      created_at: "2026-05-01T00:00:00Z",
      created_by: null,
      cover: null,
      tracks: [],
    };
    expect(contextFromManifest(m, null)).toBeNull();
  });

  it("returns null when metadata is undefined and no cover", () => {
    const m: Manifest = {
      version: 1,
      title: "Queue",
      type: "custom",
      metadata: undefined,
      created_at: "2026-05-01T00:00:00Z",
      created_by: null,
      cover: null,
      tracks: [],
    };
    expect(contextFromManifest(m, null)).toBeNull();
  });

  it("returns context when metadata has a source", () => {
    const m = {
      version: 1 as const,
      title: "My Album",
      type: "custom" as const,
      metadata: { source: "album" },
      created_at: "2026-05-01T00:00:00Z",
      created_by: null,
      cover: null,
      tracks: [],
    };
    const ctx = contextFromManifest(m, null);
    expect(ctx).not.toBeNull();
    expect(ctx!.name).toBe("My Album");
    expect(ctx!.source).toBe("album");
  });

  it("returns context when manifest has a cover but no metadata", () => {
    const m = {
      version: 1 as const,
      title: "Queue",
      type: "custom" as const,
      created_at: "2026-05-01T00:00:00Z",
      created_by: null,
      cover: "cover.jpg",
      tracks: [],
    };
    const ctx = contextFromManifest(m, "/dir");
    expect(ctx).not.toBeNull();
    expect(ctx!.imagePath).toBe("/dir/cover.jpg");
  });

  it("returns context when metadata has only description (no source)", () => {
    const m: Manifest = {
      version: 1,
      title: "Queue",
      type: "custom",
      metadata: { description: "A cool mix" },
      created_at: "2026-05-01T00:00:00Z",
      created_by: null,
      cover: null,
      tracks: [],
    };
    const ctx = contextFromManifest(m, null);
    expect(ctx).not.toBeNull();
    expect(ctx!.description).toBe("A cool mix");
    expect(ctx!.source).toBeNull();
  });
});

describe("playlist metadata roundtrip", () => {
  it("preserves description, source, and metadata through buildManifest → contextFromManifest", () => {
    const ctx = {
      name: "Discover Weekly",
      source: "spotify://playlists/abc123",
      description: "Your weekly mixtape of fresh music",
      metadata: { section: "Made for You", sourceDate: "2026-05-03T10:00:00Z" },
      remote: true,
    };
    const t = makeTrack({ path: "spotify://track1" });
    const manifest = buildManifest([t], ctx);

    expect(manifest.metadata!.source).toBe("spotify://playlists/abc123");
    expect(manifest.metadata!.description).toBe("Your weekly mixtape of fresh music");
    expect(manifest.metadata!.section).toBe("Made for You");
    expect(manifest.metadata!.sourceDate).toBe("2026-05-03T10:00:00Z");

    const restored = contextFromManifest(manifest, "/profile/main-playlist");
    expect(restored).not.toBeNull();
    expect(restored!.name).toBe("Discover Weekly");
    expect(restored!.source).toBe("spotify://playlists/abc123");
    expect(restored!.description).toBe("Your weekly mixtape of fresh music");
    expect(restored!.metadata).toEqual({ section: "Made for You", sourceDate: "2026-05-03T10:00:00Z" });
  });

  it("returns null context for plain queue with no source or cover", () => {
    const ctx = { name: "Plain Queue" };
    const manifest = buildManifest([], ctx);

    expect(manifest.metadata!.description).toBeUndefined();
    expect(contextFromManifest(manifest, null)).toBeNull();
  });

  it("preserves album detail context through roundtrip", () => {
    const ctx = {
      name: "OK Computer",
      imagePath: "/images/album.jpg",
      source: "album",
      description: "A landmark album by Radiohead...",
      metadata: { artist: "Radiohead", year: "1997" },
    };
    const manifest = buildManifest([makeTrack()], ctx);
    const restored = contextFromManifest(manifest, "/profile/main-playlist");
    expect(restored).not.toBeNull();
    expect(restored!.name).toBe("OK Computer");
    expect(restored!.source).toBe("album");
    expect(restored!.description).toBe("A landmark album by Radiohead...");
    expect(restored!.metadata).toEqual({ artist: "Radiohead", year: "1997" });
    expect(restored!.imagePath).toBe("/profile/main-playlist/cover.jpg");
  });

  it("preserves artist detail context through roundtrip", () => {
    const ctx = {
      name: "Radiohead",
      imagePath: "/images/artist.jpg",
      source: "artist",
      description: "English rock band formed in 1985...",
    };
    const manifest = buildManifest([makeTrack()], ctx);
    const restored = contextFromManifest(manifest, "/profile/main-playlist");
    expect(restored).not.toBeNull();
    expect(restored!.name).toBe("Radiohead");
    expect(restored!.source).toBe("artist");
    expect(restored!.description).toBe("English rock band formed in 1985...");
  });

  it("preserves cover-only context from album card play", () => {
    const ctx = { name: "Kid A", imagePath: "/images/kidA.jpg" };
    const manifest = buildManifest([makeTrack()], ctx);
    const restored = contextFromManifest(manifest, "/profile/main-playlist");
    expect(restored).not.toBeNull();
    expect(restored!.name).toBe("Kid A");
    expect(restored!.imagePath).toBe("/profile/main-playlist/cover.jpg");
    expect(restored!.source).toBeNull();
  });
});

describe("contextToExportMetadata", () => {
  it("flattens source, description, and metadata into a single map", () => {
    const result = contextToExportMetadata({
      name: "Discover Weekly",
      source: "spotify://playlists/abc123",
      description: "Fresh music for you",
      metadata: { section: "Made for You", sourceDate: "2026-05-03" },
    });
    expect(result).toEqual({
      source: "spotify://playlists/abc123",
      description: "Fresh music for you",
      section: "Made for You",
      sourceDate: "2026-05-03",
    });
  });

  it("returns null for empty context", () => {
    expect(contextToExportMetadata({ name: "Plain" })).toBeNull();
    expect(contextToExportMetadata(null)).toBeNull();
  });

  it("omits falsy metadata values", () => {
    const result = contextToExportMetadata({
      name: "X",
      source: "spotify://playlists/1",
      metadata: { keep: "yes", drop: "" },
    });
    expect(result).toEqual({ source: "spotify://playlists/1", keep: "yes" });
  });
});

describe("contextFromMixtapeMetadata", () => {
  it("extracts source and description, keeps the rest as metadata", () => {
    const ctx = contextFromMixtapeMetadata("Discover Weekly", "/img.jpg", {
      source: "spotify://playlists/abc123",
      description: "Fresh music for you",
      section: "Made for You",
      sourceDate: "2026-05-03",
    });
    expect(ctx.name).toBe("Discover Weekly");
    expect(ctx.imagePath).toBe("/img.jpg");
    expect(ctx.source).toBe("spotify://playlists/abc123");
    expect(ctx.description).toBe("Fresh music for you");
    expect(ctx.metadata).toEqual({ section: "Made for You", sourceDate: "2026-05-03" });
    expect(ctx.remote).toBe(false);
  });

  it("handles null metadata", () => {
    const ctx = contextFromMixtapeMetadata("Plain", null, null);
    expect(ctx.source).toBeNull();
    expect(ctx.description).toBeNull();
    expect(ctx.metadata).toBeNull();
  });
});

describe("full Spotify → Mixtape → Queue roundtrip", () => {
  it("preserves all metadata through export and re-import", () => {
    // Step 1: Spotify plugin creates a PlaylistContext
    const spotifyContext = {
      name: "Discover Weekly",
      source: "spotify://playlists/abc123",
      description: "Your weekly mixtape of fresh music",
      metadata: { Section: "Made for You", sourceDate: "2026-05-03T10:00:00Z" },
      remote: true,
    };

    // Step 2: Queue persists to main-playlist manifest (app restart)
    const track = makeTrack({ path: "spotify://track1" });
    const manifest = buildManifest([track], spotifyContext);
    const restoredFromDisk = contextFromManifest(manifest, "/profile/main-playlist");

    expect(restoredFromDisk!.source).toBe("spotify://playlists/abc123");
    expect(restoredFromDisk!.description).toBe("Your weekly mixtape of fresh music");
    expect(restoredFromDisk!.metadata).toEqual({ Section: "Made for You", sourceDate: "2026-05-03T10:00:00Z" });

    // Step 3: Export as mixtape (context → flat metadata map)
    const exportMeta = contextToExportMetadata(restoredFromDisk);

    expect(exportMeta).toEqual({
      source: "spotify://playlists/abc123",
      description: "Your weekly mixtape of fresh music",
      Section: "Made for You",
      sourceDate: "2026-05-03T10:00:00Z",
    });

    // Step 4: Open mixtape "Just Play" (flat metadata → PlaylistContext)
    const reimported = contextFromMixtapeMetadata(
      restoredFromDisk!.name,
      restoredFromDisk!.imagePath ?? null,
      exportMeta,
    );

    expect(reimported.name).toBe("Discover Weekly");
    expect(reimported.source).toBe("spotify://playlists/abc123");
    expect(reimported.description).toBe("Your weekly mixtape of fresh music");
    expect(reimported.metadata).toEqual({ Section: "Made for You", sourceDate: "2026-05-03T10:00:00Z" });

    // Step 5: Save back to playlists DB (context carries all fields)
    // Verify the fields that would be passed to save_playlist_record
    expect(reimported.source).toBe(spotifyContext.source);
    expect(reimported.description).toBe(spotifyContext.description);
    expect(reimported.metadata).toEqual(spotifyContext.metadata);
  });
});

describe("album → queue → mixtape → queue roundtrip", () => {
  it("preserves album source, description (review), and metadata through the full trip", () => {
    // Step 1: AlbumDetail builds context; handleAlbumPlayTracks enriches with cached review
    const albumContext = {
      name: "OK Computer",
      imagePath: "/images/albums/ok-computer.jpg",
      source: "album",
      description: "Radiohead's third studio album, released in 1997, is widely regarded as one of the greatest albums of all time.",
      metadata: { artist: "Radiohead", year: "1997" },
    };

    const track = makeTrack({ path: "file:///music/paranoid-android.flac" });

    // Step 2: Queue persists to main-playlist manifest (app restart)
    const manifest = buildManifest([track], albumContext);
    expect(manifest.metadata!.source).toBe("album");
    expect(manifest.metadata!.description).toBe(albumContext.description);
    expect(manifest.metadata!.artist).toBe("Radiohead");
    expect(manifest.metadata!.year).toBe("1997");

    const restoredFromDisk = contextFromManifest(manifest, "/profile/main-playlist");
    expect(restoredFromDisk!.source).toBe("album");
    expect(restoredFromDisk!.description).toBe(albumContext.description);
    expect(restoredFromDisk!.metadata).toEqual({ artist: "Radiohead", year: "1997" });

    // Step 3: Export as mixtape
    const exportMeta = contextToExportMetadata(restoredFromDisk);
    expect(exportMeta).toEqual({
      source: "album",
      description: albumContext.description,
      artist: "Radiohead",
      year: "1997",
    });

    // Step 4: Re-import from mixtape
    const reimported = contextFromMixtapeMetadata(
      restoredFromDisk!.name,
      restoredFromDisk!.imagePath ?? null,
      exportMeta,
    );
    expect(reimported.name).toBe("OK Computer");
    expect(reimported.source).toBe("album");
    expect(reimported.description).toBe(albumContext.description);
    expect(reimported.metadata).toEqual({ artist: "Radiohead", year: "1997" });
  });
});

describe("artist → queue → mixtape → queue roundtrip", () => {
  it("preserves artist source, description (bio), and name through the full trip", () => {
    // Step 1: ArtistDetail builds context; handleArtistPlayTracks enriches with cached bio
    const artistContext = {
      name: "Radiohead",
      imagePath: "/images/artists/radiohead.jpg",
      source: "artist",
      description: "Radiohead are an English rock band formed in Abingdon, Oxfordshire, in 1985.",
    };

    const track = makeTrack({ path: "file:///music/creep.flac" });

    // Step 2: Queue persists to manifest
    const manifest = buildManifest([track], artistContext);
    expect(manifest.metadata!.source).toBe("artist");
    expect(manifest.metadata!.description).toBe(artistContext.description);

    const restoredFromDisk = contextFromManifest(manifest, "/profile/main-playlist");
    expect(restoredFromDisk!.source).toBe("artist");
    expect(restoredFromDisk!.description).toBe(artistContext.description);
    expect(restoredFromDisk!.metadata).toBeNull();

    // Step 3: Export as mixtape
    const exportMeta = contextToExportMetadata(restoredFromDisk);
    expect(exportMeta).toEqual({
      source: "artist",
      description: artistContext.description,
    });

    // Step 4: Re-import from mixtape
    const reimported = contextFromMixtapeMetadata(
      restoredFromDisk!.name,
      restoredFromDisk!.imagePath ?? null,
      exportMeta,
    );
    expect(reimported.name).toBe("Radiohead");
    expect(reimported.source).toBe("artist");
    expect(reimported.description).toBe(artistContext.description);
    expect(reimported.metadata).toBeNull();
  });

  it("handles artist with no cached bio gracefully", () => {
    const artistContext = {
      name: "Unknown Artist",
      imagePath: null,
      source: "artist",
    };

    const manifest = buildManifest([], artistContext);
    const restored = contextFromManifest(manifest, null);
    expect(restored!.source).toBe("artist");
    expect(restored!.description).toBeNull();

    const exportMeta = contextToExportMetadata(restored);
    expect(exportMeta).toEqual({ source: "artist" });

    const reimported = contextFromMixtapeMetadata("Unknown Artist", null, exportMeta);
    expect(reimported.source).toBe("artist");
    expect(reimported.description).toBeNull();
    expect(reimported.metadata).toBeNull();
  });
});

describe("plugin album → queue → mixtape → queue roundtrip", () => {
  it("preserves plugin source and album metadata through the full trip", () => {
    // Step 1: plugin builds context with source and metadata
    const tidalContext = {
      name: "OK Computer - Radiohead",
      source: "tidal://albums/12345",
      metadata: { artist: "Radiohead", year: "1997", tidalId: "12345" },
      remote: true,
    };

    const track = makeTrack({ path: "tidal://67890" });

    // Step 2: Queue persists to manifest (app restart)
    const manifest = buildManifest([track], tidalContext);
    expect(manifest.metadata!.source).toBe("tidal://albums/12345");
    expect(manifest.metadata!.artist).toBe("Radiohead");
    expect(manifest.metadata!.tidalId).toBe("12345");
    expect(manifest.tracks[0].thumb).toBeNull();

    const restored = contextFromManifest(manifest, "/profile/main-playlist");
    expect(restored!.source).toBe("tidal://albums/12345");
    expect(restored!.metadata).toEqual({ artist: "Radiohead", year: "1997", tidalId: "12345" });
    expect(restored!.remote).toBe(true);

    // Step 3: Export as mixtape
    const exportMeta = contextToExportMetadata(restored);
    expect(exportMeta).toEqual({
      source: "tidal://albums/12345",
      artist: "Radiohead",
      year: "1997",
      tidalId: "12345",
    });

    // Step 4: Re-import from mixtape
    const reimported = contextFromMixtapeMetadata(
      restored!.name,
      restored!.imagePath ?? null,
      exportMeta,
    );
    expect(reimported.name).toBe("OK Computer - Radiohead");
    expect(reimported.source).toBe("tidal://albums/12345");
    expect(reimported.metadata).toEqual({ artist: "Radiohead", year: "1997", tidalId: "12345" });
  });
});

describe("queueItemLocalThumb", () => {
  const dir = "/app/main-playlist";

  it("returns null until a thumb-ready signal has recorded thumbInfo (avoids requesting a not-yet-written file)", () => {
    // No entry yet → the backend has not confirmed the write.
    const r = queueItemLocalThumb({
      mainPlaylistDir: dir,
      uri: "spotify://abc",
      thumbInfo: {},
    });
    expect(r).toBeNull();
  });

  it("returns the versioned thumb path using the backend-supplied filename", () => {
    // The filename comes from the event, not a JS slug computation.
    const r = queueItemLocalThumb({
      mainPlaylistDir: dir,
      uri: "spotify://abc",
      thumbInfo: { "spotify://abc": { version: 1, filename: "spotifyabc.jpg" } },
    });
    expect(r).toBe("/app/main-playlist/thumbs/spotifyabc.jpg#v=1");
  });

  it("uses a thumb whenever one exists on disk — no remote gate", () => {
    // A local/library URI with a recorded thumb resolves just like a remote one;
    // the only gate is whether thumbInfo has an entry.
    const r = queueItemLocalThumb({
      mainPlaylistDir: dir,
      uri: "file:///x.mp3",
      thumbInfo: { "file:///x.mp3": { version: 3, filename: "filex.mp3.jpg" } },
    });
    expect(r).toBe("/app/main-playlist/thumbs/filex.mp3.jpg#v=3");
  });

  it("returns null when dir or uri is missing", () => {
    expect(queueItemLocalThumb({ mainPlaylistDir: null, uri: "spotify://abc", thumbInfo: { "spotify://abc": { version: 1, filename: "spotifyabc.jpg" } } })).toBeNull();
    expect(queueItemLocalThumb({ mainPlaylistDir: dir, uri: null, thumbInfo: {} })).toBeNull();
  });
});

describe("tracksFromManifest key generation", () => {
  function manifest(n: number): Manifest {
    return {
      version: 1, title: "P", type: "custom", created_at: "", created_by: null, cover: null,
      tracks: Array.from({ length: n }, (_, i) => ({
        title: `T${i}`, artist: "A", album: null, duration_secs: 100, file: `file:///${i}.mp3`, thumb: null,
      })),
    };
  }

  it("assigns unique keys within a single restore", () => {
    const tracks = tracksFromManifest(manifest(3));
    const keys = tracks.map(t => t.key);
    expect(new Set(keys).size).toBe(3);
  });

  // Regression: a private local counter in tracksFromManifest restarted at ext:1
  // on every restore and collided with keys minted later by nextExternalKey()
  // (enqueue, play-next, plugin tracks). Duplicate React keys corrupted
  // reconciliation — phantom queue rows that survived clear/remove until restart.
  it("does not collide with keys minted later by nextExternalKey", () => {
    const restored = tracksFromManifest(manifest(2)).map(t => t.key);
    // Simulate subsequent queue mutations (enqueue etc.) that mint external keys.
    const minted = [nextExternalKey(), nextExternalKey()];
    const all = [...restored, ...minted];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("format persistence", () => {
  // Regression: format was not stored in the manifest and tracksFromManifest
  // hardcoded format: null. After restart a restored video was classified as
  // audio (isVideoTrack reads format) and played through the audio element.
  it("round-trips track format through buildManifest → tracksFromManifest", () => {
    const video = makeTrack({ path: "file:///clip.mp4", format: "mp4" });
    const audio = makeTrack({ path: "file:///song.flac", format: "flac" });
    const manifest = buildManifest([video, audio], { name: "P" });
    const restored = tracksFromManifest(manifest);
    expect(restored[0].format).toBe("mp4");
    expect(restored[1].format).toBe("flac");
  });

  it("defaults format to null for legacy manifests without the field", () => {
    const legacy: Manifest = {
      version: 1, title: "P", type: "custom", created_at: "", created_by: null, cover: null,
      tracks: [{ title: "T", artist: "A", album: null, duration_secs: 100, file: "file:///x.mp3", thumb: null }],
    };
    const restored = tracksFromManifest(legacy);
    expect(restored[0].format).toBeNull();
  });
});
