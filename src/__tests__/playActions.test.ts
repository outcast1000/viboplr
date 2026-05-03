import { describe, it, expect } from "vitest";
import {
  extractDescription,
  buildAlbumContext,
  buildArtistContext,
  buildTagContext,
  type InfoRow,
} from "../hooks/usePlayActions";

describe("extractDescription", () => {
  it("extracts summary from ok row matching the info type", () => {
    const rows: InfoRow[] = [
      [1, "artist_bio", JSON.stringify({ summary: "English rock band", full: "Full bio text" }), "ok", 1700000000],
    ];
    expect(extractDescription(rows, "artist_bio")).toBe("English rock band");
  });

  it("falls back to full when summary is empty", () => {
    const rows: InfoRow[] = [
      [1, "album_wiki", JSON.stringify({ summary: "", full: "Full review" }), "ok", 1700000000],
    ];
    expect(extractDescription(rows, "album_wiki")).toBe("Full review");
  });

  it("returns null when info type not found", () => {
    const rows: InfoRow[] = [
      [1, "artist_bio", JSON.stringify({ summary: "Bio" }), "ok", 1700000000],
    ];
    expect(extractDescription(rows, "album_wiki")).toBeNull();
  });

  it("returns null when status is not ok", () => {
    const rows: InfoRow[] = [
      [1, "artist_bio", JSON.stringify({ summary: "Bio" }), "not_found", 1700000000],
    ];
    expect(extractDescription(rows, "artist_bio")).toBeNull();
  });

  it("returns null when status is error", () => {
    const rows: InfoRow[] = [
      [1, "artist_bio", "{}", "error", 1700000000],
    ];
    expect(extractDescription(rows, "artist_bio")).toBeNull();
  });

  it("returns null for empty rows", () => {
    expect(extractDescription([], "artist_bio")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const rows: InfoRow[] = [
      [1, "artist_bio", "not json", "ok", 1700000000],
    ];
    expect(extractDescription(rows, "artist_bio")).toBeNull();
  });

  it("returns null when both summary and full are empty", () => {
    const rows: InfoRow[] = [
      [1, "artist_bio", JSON.stringify({ summary: "", full: "" }), "ok", 1700000000],
    ];
    expect(extractDescription(rows, "artist_bio")).toBeNull();
  });

  it("picks the correct row when multiple info types exist", () => {
    const rows: InfoRow[] = [
      [1, "artist_bio", JSON.stringify({ summary: "Bio" }), "ok", 1700000000],
      [2, "album_wiki", JSON.stringify({ summary: "Review" }), "ok", 1700000000],
      [3, "track_info", JSON.stringify({ summary: "Info" }), "ok", 1700000000],
    ];
    expect(extractDescription(rows, "album_wiki")).toBe("Review");
    expect(extractDescription(rows, "artist_bio")).toBe("Bio");
    expect(extractDescription(rows, "track_info")).toBe("Info");
  });
});

describe("buildAlbumContext", () => {
  it("builds context with full album data", () => {
    const album = { id: 1, title: "OK Computer", artist_id: 1, artist_name: "Radiohead", year: 1997, track_count: 12, liked: 0 };
    const ctx = buildAlbumContext(album, "/images/album.jpg");
    expect(ctx).toEqual({
      name: "OK Computer",
      imagePath: "/images/album.jpg",
      source: "album",
      metadata: { artist: "Radiohead", year: "1997" },
    });
  });

  it("handles missing artist and year", () => {
    const album = { id: 1, title: "Untitled", artist_id: null, artist_name: null, year: null, track_count: 1, liked: 0 };
    const ctx = buildAlbumContext(album, null);
    expect(ctx.name).toBe("Untitled");
    expect(ctx.metadata).toEqual({});
    expect(ctx.imagePath).toBeNull();
  });

  it("handles undefined album", () => {
    const ctx = buildAlbumContext(undefined, null);
    expect(ctx.name).toBe("Unknown");
    expect(ctx.source).toBe("album");
  });
});

describe("buildArtistContext", () => {
  it("builds context with artist data", () => {
    const artist = { id: 1, name: "Radiohead", track_count: 50, liked: 0 };
    const ctx = buildArtistContext(artist, "/images/artist.jpg");
    expect(ctx).toEqual({
      name: "Radiohead",
      imagePath: "/images/artist.jpg",
      source: "artist",
    });
  });

  it("handles undefined artist", () => {
    const ctx = buildArtistContext(undefined, null);
    expect(ctx.name).toBe("Unknown");
    expect(ctx.source).toBe("artist");
  });
});

describe("buildTagContext", () => {
  it("builds context with tag data", () => {
    const tag = { id: 1, name: "Rock", track_count: 100, liked: 0 };
    const ctx = buildTagContext(tag, "/images/tag.jpg");
    expect(ctx).toEqual({
      name: "Rock",
      imagePath: "/images/tag.jpg",
      source: "tag",
    });
  });

  it("handles undefined tag", () => {
    const ctx = buildTagContext(undefined, null);
    expect(ctx.name).toBe("Unknown");
    expect(ctx.source).toBe("tag");
  });
});

describe("context → manifest roundtrip", () => {
  // Import buildManifest/contextFromManifest to verify the contexts survive persistence
  // This is an integration test between usePlayActions context builders and mainPlaylist
  it("album context survives buildManifest → contextFromManifest", async () => {
    const { buildManifest, contextFromManifest } = await import("../mainPlaylist");
    const album = { id: 1, title: "OK Computer", artist_id: 1, artist_name: "Radiohead", year: 1997, track_count: 12, liked: 0 };
    const ctx = buildAlbumContext(album, "/images/album.jpg");

    const manifest = buildManifest([], ctx);
    expect(manifest.title).toBe("OK Computer");
    expect(manifest.metadata!.source).toBe("album");
    expect(manifest.metadata!.artist).toBe("Radiohead");

    const restored = contextFromManifest(manifest, "/dir");
    expect(restored).not.toBeNull();
    expect(restored!.source).toBe("album");
    expect(restored!.metadata).toEqual({ artist: "Radiohead", year: "1997" });
  });

  it("artist context survives buildManifest → contextFromManifest", async () => {
    const { buildManifest, contextFromManifest } = await import("../mainPlaylist");
    const artist = { id: 1, name: "Radiohead", track_count: 50, liked: 0 };
    const ctx = buildArtistContext(artist, "/images/artist.jpg");

    const manifest = buildManifest([], ctx);
    const restored = contextFromManifest(manifest, "/dir");
    expect(restored).not.toBeNull();
    expect(restored!.name).toBe("Radiohead");
    expect(restored!.source).toBe("artist");
  });

  it("tag context survives buildManifest → contextFromManifest", async () => {
    const { buildManifest, contextFromManifest } = await import("../mainPlaylist");
    const tag = { id: 1, name: "Rock", track_count: 100, liked: 0 };
    const ctx = buildTagContext(tag, "/images/tag.jpg");

    const manifest = buildManifest([], ctx);
    const restored = contextFromManifest(manifest, "/dir");
    expect(restored).not.toBeNull();
    expect(restored!.name).toBe("Rock");
    expect(restored!.source).toBe("tag");
  });

  it("album context with description survives roundtrip", async () => {
    const { buildManifest, contextFromManifest } = await import("../mainPlaylist");
    const album = { id: 1, title: "OK Computer", artist_id: 1, artist_name: "Radiohead", year: 1997, track_count: 12, liked: 0 };
    const ctx = { ...buildAlbumContext(album, null), description: "A landmark album" };

    const manifest = buildManifest([], ctx);
    expect(manifest.metadata!.description).toBe("A landmark album");

    const restored = contextFromManifest(manifest, null);
    expect(restored!.description).toBe("A landmark album");
  });
});
