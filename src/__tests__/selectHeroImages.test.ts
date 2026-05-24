import { describe, it, expect } from "vitest";
import {
  selectArtistAlbumHeroImages,
  selectTagTopArtistHeroImages,
  type AlbumLite,
} from "../utils/selectHeroImages";

const MAX = 4;

function album(id: number, title: string, year: number | null, artistId: number, artistName: string): AlbumLite {
  return { id, title, year, artist_id: artistId, artist_name: artistName };
}

describe("selectArtistAlbumHeroImages", () => {
  it("returns first 4 albums by year ascending for the artist", () => {
    const albums: AlbumLite[] = [
      album(10, "Late",       2020, 1, "Alpha"),
      album(11, "Early",      2000, 1, "Alpha"),
      album(12, "Mid",        2010, 1, "Alpha"),
      album(13, "Latest",     2024, 1, "Alpha"),
      album(14, "Earlier",    1995, 1, "Alpha"),
      album(15, "OtherArtist",1990, 2, "Beta"),
    ];
    const resolve = (title: string) => `/cache/${title}.jpg`;
    const { resolved, pending } = selectArtistAlbumHeroImages(albums, 1, resolve, MAX);
    expect(resolved).toEqual([
      "/cache/Earlier.jpg",
      "/cache/Early.jpg",
      "/cache/Mid.jpg",
      "/cache/Late.jpg",
    ]);
    expect(pending).toEqual([]);
  });

  it("filters out artists that don't match", () => {
    const albums = [album(10, "A", 2000, 1, "Alpha"), album(11, "B", 2001, 2, "Beta")];
    const { resolved } = selectArtistAlbumHeroImages(albums, 99, () => "/anything.jpg", MAX);
    expect(resolved).toEqual([]);
  });

  it("returns empty when the artist has no albums", () => {
    const { resolved, pending } = selectArtistAlbumHeroImages([], 1, () => "/a.jpg", MAX);
    expect(resolved).toEqual([]);
    expect(pending).toEqual([]);
  });

  it("breaks ties on year by album id ascending", () => {
    const albums = [
      album(20, "Z", 2000, 1, "Alpha"),
      album(10, "A", 2000, 1, "Alpha"),
      album(15, "M", 2000, 1, "Alpha"),
    ];
    const resolve = (title: string) => `/${title}`;
    const { resolved } = selectArtistAlbumHeroImages(albums, 1, resolve, MAX);
    expect(resolved).toEqual(["/A", "/M", "/Z"]);
  });

  it("treats null year as 0 (sorted before albums with a year)", () => {
    const albums = [
      album(10, "Dated", 1999, 1, "Alpha"),
      album(11, "Undated", null, 1, "Alpha"),
    ];
    const resolve = (title: string) => `/${title}`;
    const { resolved } = selectArtistAlbumHeroImages(albums, 1, resolve, MAX);
    expect(resolved).toEqual(["/Undated", "/Dated"]);
  });

  it("places uncached candidates in `pending` and skips them in `resolved`", () => {
    const albums = [
      album(10, "Cached1", 2000, 1, "Alpha"),
      album(11, "Missing", 2001, 1, "Alpha"),
      album(12, "Cached2", 2002, 1, "Alpha"),
    ];
    const resolve = (title: string) => (title === "Missing" ? null : `/${title}.jpg`);
    const { resolved, pending } = selectArtistAlbumHeroImages(albums, 1, resolve, MAX);
    expect(resolved).toEqual(["/Cached1.jpg", "/Cached2.jpg"]);
    expect(pending).toEqual([{ title: "Missing", artistName: "Alpha" }]);
  });

  it("caps at the configured maximum", () => {
    const albums = [
      album(1, "A", 2001, 1, "Alpha"),
      album(2, "B", 2002, 1, "Alpha"),
      album(3, "C", 2003, 1, "Alpha"),
      album(4, "D", 2004, 1, "Alpha"),
      album(5, "E", 2005, 1, "Alpha"),
    ];
    const { resolved } = selectArtistAlbumHeroImages(albums, 1, t => `/${t}`, MAX);
    expect(resolved).toHaveLength(4);
    expect(resolved[3]).toBe("/D");
  });
});

describe("selectTagTopArtistHeroImages", () => {
  it("returns resolved images in input order", () => {
    const top = [
      { name: "Alpha", track_count: 10 },
      { name: "Beta",  track_count: 7 },
      { name: "Gamma", track_count: 3 },
    ];
    const resolve = (n: string) => `/${n}.jpg`;
    const { resolved, pending } = selectTagTopArtistHeroImages(top, resolve);
    expect(resolved).toEqual(["/Alpha.jpg", "/Beta.jpg", "/Gamma.jpg"]);
    expect(pending).toEqual([]);
  });

  it("filters out unresolved entries and reports them in `pending`", () => {
    const top = [
      { name: "Alpha", track_count: 10 },
      { name: "Beta",  track_count: 7 },
    ];
    const resolve = (n: string) => (n === "Alpha" ? "/Alpha.jpg" : null);
    const { resolved, pending } = selectTagTopArtistHeroImages(top, resolve);
    expect(resolved).toEqual(["/Alpha.jpg"]);
    expect(pending).toEqual(["Beta"]);
  });

  it("returns empty arrays when input is empty", () => {
    const { resolved, pending } = selectTagTopArtistHeroImages([], () => "/a");
    expect(resolved).toEqual([]);
    expect(pending).toEqual([]);
  });
});
