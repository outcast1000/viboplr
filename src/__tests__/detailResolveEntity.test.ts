import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));

import { resolveDetailEntity } from "../utils/detailResolveEntity";
import type { Track } from "../types";

const track = (id: number, title: string, artist_name: string) => ({ id, title, artist_name }) as Track;

describe("resolveDetailEntity", () => {
  const tracks = [track(1, "Jóga", "Björk"), track(2, "Hunter", "Björk"), track(3, "Hunter", "Other")];
  const getArtistImage = (name: string) => (name === "Björk" ? "/img/bjork.jpg" : null);

  it("matches a track accent- and case-insensitively against the default artist", () => {
    expect(resolveDetailEntity("track", "joga", { tracks, defaultArtist: "Bjork", getArtistImage })).toEqual({ id: 1 });
  });

  it("uses the artist carried in `title|||artist` over the default", () => {
    expect(resolveDetailEntity("track", "hunter|||other", { tracks, defaultArtist: "Björk", getArtistImage })).toEqual({ id: 3 });
  });

  it("links the page's own artist by id, with its image", () => {
    expect(resolveDetailEntity("artist", "Björk", { tracks, artist: { id: 9, name: "BJORK" }, getArtistImage }))
      .toEqual({ id: 9, imageSrc: "asset:///img/bjork.jpg" });
  });

  it("returns only the image for another artist, nothing for an unknown one", () => {
    expect(resolveDetailEntity("artist", "Björk", { tracks, getArtistImage })).toEqual({ imageSrc: "asset:///img/bjork.jpg" });
    expect(resolveDetailEntity("artist", "Nobody", { tracks, getArtistImage })).toBeUndefined();
    expect(resolveDetailEntity("track", "Missing", { tracks, getArtistImage })).toBeUndefined();
  });
});
