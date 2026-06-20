import { describe, it, expect } from "vitest";
import { resolveShelfPlayAction } from "../utils/homeShelfPlay";
import type { HomeShelfItem } from "../types/plugin";

describe("resolveShelfPlayAction", () => {
  it("album with libraryId → album-id", () => {
    const item = { libraryId: 5, name: "Album" } as HomeShelfItem;
    expect(resolveShelfPlayAction("album-cards", item)).toEqual({ kind: "album-id", id: 5 });
  });

  it("album without libraryId but with tracks → tracks + name context", () => {
    const tracks = [{ title: "t1" }];
    const item = { name: "Album", tracks } as HomeShelfItem;
    expect(resolveShelfPlayAction("album-cards", item)).toEqual({
      kind: "tracks", tracks, context: { name: "Album" },
    });
  });

  it("album with neither libraryId nor tracks → none", () => {
    const item = { name: "Album" } as HomeShelfItem;
    expect(resolveShelfPlayAction("album-cards", item)).toEqual({ kind: "none" });
  });

  it("artist with libraryId → artist-id", () => {
    const item = { libraryId: 9, name: "Artist" } as HomeShelfItem;
    expect(resolveShelfPlayAction("artist-cards", item)).toEqual({ kind: "artist-id", id: 9 });
  });

  it("album-cards item tagged entityKind=artist → artist-id (mixed jump-back-in shelf)", () => {
    const item = { libraryId: 9, name: "Artist", entityKind: "artist" } as HomeShelfItem;
    expect(resolveShelfPlayAction("album-cards", item)).toEqual({ kind: "artist-id", id: 9 });
  });

  it("album-cards item tagged entityKind=artist without libraryId → none", () => {
    const item = { name: "Artist", entityKind: "artist" } as HomeShelfItem;
    expect(resolveShelfPlayAction("album-cards", item)).toEqual({ kind: "none" });
  });

  it("album-cards item tagged entityKind=album → album-id (default path)", () => {
    const item = { libraryId: 5, name: "Album", entityKind: "album" } as HomeShelfItem;
    expect(resolveShelfPlayAction("album-cards", item)).toEqual({ kind: "album-id", id: 5 });
  });

  it("artist without libraryId → none", () => {
    const item = { name: "Artist" } as HomeShelfItem;
    expect(resolveShelfPlayAction("artist-cards", item)).toEqual({ kind: "none" });
  });

  it("playlist normal → tracks + playlist context", () => {
    const tracks = [{ title: "t1" }];
    const item = { id: "p1", name: "Mix", coverUrl: "http://x/c.jpg", tracks } as HomeShelfItem;
    expect(resolveShelfPlayAction("playlist-cards", item)).toEqual({
      kind: "tracks", tracks,
      context: { name: "Mix", imagePath: "http://x/c.jpg", source: "playlist" },
    });
  });

  it("playlist with __radioSeed → radio (carries card coverUrl as fallback)", () => {
    const seed = { title: "Seed", artist_name: "A", image_url: "http://x/s.jpg" };
    const tracks = [{ title: "Seed", __radioSeed: seed }];
    const item = { id: "r1", name: "Radio", coverUrl: "http://x/card.jpg", tracks } as unknown as HomeShelfItem;
    expect(resolveShelfPlayAction("playlist-cards", item)).toEqual({ kind: "radio", seed, coverUrl: "http://x/card.jpg" });
  });

  it("playlist with __radioSeed and no coverUrl → radio with null coverUrl", () => {
    const seed = { title: "Seed", artist_name: "A", image_url: "http://x/s.jpg" };
    const tracks = [{ title: "Seed", __radioSeed: seed }];
    const item = { id: "r1", name: "Radio", coverUrl: null, tracks } as unknown as HomeShelfItem;
    expect(resolveShelfPlayAction("playlist-cards", item)).toEqual({ kind: "radio", seed, coverUrl: null });
  });

  it("track-rows → tracks (single)", () => {
    const track = { title: "Song", artist_name: "A" };
    const item = { track } as HomeShelfItem;
    expect(resolveShelfPlayAction("track-rows", item)).toEqual({ kind: "tracks", tracks: [track] });
  });
});
