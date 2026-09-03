import { describe, it, expect } from "vitest";
import { filterPlaylistTracks, sortPlaylistTracks } from "../utils/playlistTrackList";
import type { SortKey } from "../sortChain";

const t = (
  title: string,
  artist: string | null = null,
  album: string | null = null,
  duration: number | null = null,
  source: string | null = null,
  liked = 0,
) => ({ title, artist_name: artist, album_name: album, duration_secs: duration, source, liked });

describe("filterPlaylistTracks", () => {
  const rows = [
    t("Karma Police", "Radiohead", "OK Computer", 261, "file:///a.flac"),
    t("Jóga", "Björk", "Homogenic", 305, "file:///b.mp3"),
    t("Intro Video", "Someone", null, 120, "file:///c.mp4"),
  ];

  it("returns the same array when nothing filters (no re-render churn)", () => {
    expect(filterPlaylistTracks(rows, "", "all")).toBe(rows);
    expect(filterPlaylistTracks(rows, "   ", "all")).toBe(rows);
  });

  it("matches title, artist, and album case-insensitively", () => {
    expect(filterPlaylistTracks(rows, "karma", "all").map(r => r.title)).toEqual(["Karma Police"]);
    expect(filterPlaylistTracks(rows, "RADIOHEAD", "all").map(r => r.title)).toEqual(["Karma Police"]);
    expect(filterPlaylistTracks(rows, "homogenic", "all").map(r => r.title)).toEqual(["Jóga"]);
    expect(filterPlaylistTracks(rows, "zzz", "all")).toEqual([]);
  });

  it("filters by media type from the source extension", () => {
    expect(filterPlaylistTracks(rows, "", "video").map(r => r.title)).toEqual(["Intro Video"]);
    expect(filterPlaylistTracks(rows, "", "audio").map(r => r.title)).toEqual(["Karma Police", "Jóga"]);
  });

  it("treats an extension-less source as audio", () => {
    const stream = [t("Live Stream", null, null, null, "https://example.com/stream")];
    expect(filterPlaylistTracks(stream, "", "audio")).toHaveLength(1);
    expect(filterPlaylistTracks(stream, "", "video")).toHaveLength(0);
  });

  it("combines text and media filters", () => {
    expect(filterPlaylistTracks(rows, "intro", "audio")).toEqual([]);
    expect(filterPlaylistTracks(rows, "intro", "video").map(r => r.title)).toEqual(["Intro Video"]);
  });
});

describe("sortPlaylistTracks", () => {
  const rows = [
    t("b", "Y", "M", 200, null, 1),
    t("a", "X", "N", 100, null, 0),
    t("C", "X", "M", 300, null, -1),
  ];

  it("keeps the playlist's own order on an empty chain (same array)", () => {
    expect(sortPlaylistTracks(rows, [], 1)).toBe(rows);
  });

  it("sorts by title case-insensitively, both directions", () => {
    expect(sortPlaylistTracks(rows, [{ field: "title", dir: "asc" }], 1).map(r => r.title)).toEqual(["a", "b", "C"]);
    expect(sortPlaylistTracks(rows, [{ field: "title", dir: "desc" }], 1).map(r => r.title)).toEqual(["C", "b", "a"]);
  });

  it("sorts by duration and liked", () => {
    expect(sortPlaylistTracks(rows, [{ field: "duration", dir: "asc" }], 1).map(r => r.duration_secs)).toEqual([100, 200, 300]);
    expect(sortPlaylistTracks(rows, [{ field: "liked", dir: "desc" }], 1).map(r => r.liked)).toEqual([1, 0, -1]);
  });

  it("applies later chain keys only on ties, keeping playlist order on full ties", () => {
    const chain: SortKey[] = [{ field: "artist", dir: "asc" }, { field: "title", dir: "asc" }];
    expect(sortPlaylistTracks(rows, chain, 1).map(r => r.title)).toEqual(["a", "C", "b"]);
    // Full tie → stable sort keeps original (position) order.
    const ties = [t("same", "Z"), t("same", "Z")];
    expect(sortPlaylistTracks(ties, chain, 1)).toEqual(ties);
  });

  it("shuffle is deterministic per seed and re-rolls on a new seed", () => {
    const many = Array.from({ length: 20 }, (_, i) => t(`t${i}`));
    const chain: SortKey[] = [{ field: "random", dir: "asc" }];
    const a = sortPlaylistTracks(many, chain, 7).map(r => r.title);
    const b = sortPlaylistTracks(many, chain, 7).map(r => r.title);
    const c = sortPlaylistTracks(many, chain, 8).map(r => r.title);
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
    expect([...a].sort()).toEqual([...c].sort());
  });

  it("does not mutate the input when sorting", () => {
    const copy = rows.slice();
    sortPlaylistTracks(rows, [{ field: "title", dir: "asc" }], 1);
    expect(rows).toEqual(copy);
  });

  it("ignores unknown fields instead of throwing", () => {
    expect(sortPlaylistTracks(rows, [{ field: "bogus", dir: "asc" }], 1).map(r => r.title)).toEqual(rows.map(r => r.title));
  });
});
