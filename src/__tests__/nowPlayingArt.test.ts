import { describe, it, expect, vi } from "vitest";
import { resolveNowPlayingArt } from "../utils/nowPlayingArt";
import type { QueueTrack } from "../types";

function makeTrack(over: Partial<QueueTrack> = {}): QueueTrack {
  return {
    key: "lib:1",
    path: "file:///music/a.flac",
    title: "Song",
    artist_name: "Artist",
    album_title: "Album",
    duration_secs: 200,
    liked: 0,
    ...over,
  } as QueueTrack;
}

/** Nothing cached, nothing settled — every lookup is in flight. */
const allPending = {
  getAlbumImage: () => null,
  getArtistImage: () => null,
  isAlbumImageResolved: () => false,
  isArtistImageResolved: () => false,
};

/** Nothing cached, but both lookups have come back empty. */
const allSettledEmpty = {
  getAlbumImage: () => null,
  getArtistImage: () => null,
  isAlbumImageResolved: () => true,
  isArtistImageResolved: () => true,
};

describe("resolveNowPlayingArt", () => {
  it("prefers an explicit image_url and never reports pending for it", () => {
    const getAlbumImage = vi.fn(() => "/covers/album.jpg");
    const art = resolveNowPlayingArt(
      makeTrack({ image_url: "https://cdn.example/cover.jpg" }),
      { ...allPending, getAlbumImage },
    );
    expect(art).toEqual({ path: "https://cdn.example/cover.jpg", pending: false });
    // An explicit URL short-circuits the chain — no lookup should be started.
    expect(getAlbumImage).not.toHaveBeenCalled();
  });

  it("uses the album image when there is one", () => {
    const art = resolveNowPlayingArt(makeTrack(), {
      ...allPending,
      getAlbumImage: () => "/covers/album.jpg",
    });
    expect(art).toEqual({ path: "/covers/album.jpg", pending: false });
  });

  it("falls back to the artist image when the album has none", () => {
    const art = resolveNowPlayingArt(makeTrack(), {
      ...allSettledEmpty,
      getArtistImage: () => "/covers/artist.jpg",
    });
    expect(art).toEqual({ path: "/covers/artist.jpg", pending: false });
  });

  it("keys the album lookup by the album artist when the track carries one", () => {
    // Compilation case: the album row is owned by "Various Artists", so a
    // lookup by the track artist would miss the cached cover.
    const getAlbumImage = vi.fn((_name: string, artist?: string | null) =>
      artist === "Various Artists" ? "/covers/comp.jpg" : null);
    const art = resolveNowPlayingArt(
      makeTrack({ album_artist_name: "Various Artists" }),
      { ...allPending, getAlbumImage },
    );
    expect(art).toEqual({ path: "/covers/comp.jpg", pending: false });
    expect(getAlbumImage).toHaveBeenCalledWith("Album", "Various Artists");
  });

  it("keys the album lookup by the track artist when no album artist is known", () => {
    const getAlbumImage = vi.fn(() => null);
    resolveNowPlayingArt(makeTrack(), { ...allSettledEmpty, getAlbumImage });
    expect(getAlbumImage).toHaveBeenCalledWith("Album", "Artist");
  });

  it("reports pending while a lookup is still in flight", () => {
    expect(resolveNowPlayingArt(makeTrack(), allPending)).toEqual({
      path: null,
      pending: true,
    });
  });

  it("reports pending when only the artist leg is outstanding", () => {
    const art = resolveNowPlayingArt(makeTrack(), {
      ...allPending,
      isAlbumImageResolved: () => true,
    });
    expect(art).toEqual({ path: null, pending: true });
  });

  it("stops reporting pending once both lookups have settled empty", () => {
    expect(resolveNowPlayingArt(makeTrack(), allSettledEmpty)).toEqual({
      path: null,
      pending: false,
    });
  });

  it("is not pending when there is nothing to look up", () => {
    const track = makeTrack({ album_title: null, artist_name: null });
    expect(resolveNowPlayingArt(track, allPending)).toEqual({
      path: null,
      pending: false,
    });
  });

  it("only awaits the legs it actually has a name for", () => {
    // No album title: the album lookup never runs, so its unresolved state must
    // not hold the view in the art regime forever.
    const track = makeTrack({ album_title: null });
    const art = resolveNowPlayingArt(track, {
      ...allPending,
      isArtistImageResolved: () => true,
    });
    expect(art).toEqual({ path: null, pending: false });
  });

  it("assumes settled when no resolution signal is supplied", () => {
    const art = resolveNowPlayingArt(makeTrack(), {
      getAlbumImage: () => null,
      getArtistImage: () => null,
    });
    expect(art).toEqual({ path: null, pending: false });
  });
});
