import { describe, it, expect, vi } from "vitest";
import type { SearchAllResults, Track, Artist, Album } from "../types";
import { patchSearchResultsLike, buildSearchLikeHandlers } from "../utils/searchLikes";

const track = (id: number, liked = 0): Track =>
  ({ id, title: `T${id}`, artist_name: "A", liked } as unknown as Track);
const artist = (id: number, liked = 0): Artist =>
  ({ id, name: `Ar${id}`, track_count: 1, liked, album_count: 1 } as unknown as Artist);
const album = (id: number, liked = 0): Album =>
  ({ id, title: `Al${id}`, artist_id: 1, artist_name: "A", year: null, track_count: 1, liked } as unknown as Album);

const results = (): SearchAllResults => ({
  tracks: [track(1), track(2, 1)],
  artists: [artist(1), artist(2, -1)],
  albums: [album(1, 1), album(2)],
});

describe("patchSearchResultsLike", () => {
  it("advances only the addressed row through the tri-state cycle", () => {
    // like on an already-liked row clears it
    expect(patchSearchResultsLike(results(), "album", 1, "like").albums[0].liked).toBe(0);
    // dislike from neutral → -1, from -1 → 0
    expect(patchSearchResultsLike(results(), "artist", 1, "dislike").artists[0].liked).toBe(-1);
    expect(patchSearchResultsLike(results(), "artist", 2, "dislike").artists[1].liked).toBe(0);
    expect(patchSearchResultsLike(results(), "album", 1, "like").albums[0].liked).toBe(0);
  });

  it("leaves the other kinds untouched by reference", () => {
    const before = results();
    const after = patchSearchResultsLike(before, "album", 2, "like");
    expect(after.tracks).toBe(before.tracks);
    expect(after.artists).toBe(before.artists);
    expect(after.albums[0]).toBe(before.albums[0]);
    expect(after.albums[1].liked).toBe(1);
  });
});

describe("buildSearchLikeHandlers", () => {
  it("returns undefined without deps so surfaces render no hearts", () => {
    expect(buildSearchLikeHandlers(undefined, vi.fn())).toBeUndefined();
  });

  it("patches artist/album rows then forwards; track rows only forward (their hearts read the store)", () => {
    const deps = {
      onToggleTrackLike: vi.fn(), onToggleTrackDislike: vi.fn(),
      onToggleArtistLike: vi.fn(), onToggleArtistDislike: vi.fn(),
      onToggleAlbumLike: vi.fn(), onToggleAlbumDislike: vi.fn(),
    };
    let state = results();
    const setResults = vi.fn((fn: (p: SearchAllResults) => SearchAllResults) => { state = fn(state); });
    const h = buildSearchLikeHandlers(deps, setResults)!;

    const tracksBefore = state.tracks;
    h.toggleTrackLike(state.tracks[0]);
    expect(state.tracks).toBe(tracksBefore);
    expect(deps.onToggleTrackLike).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));

    h.toggleAlbumDislike(2);
    expect(state.albums[1].liked).toBe(-1);
    expect(deps.onToggleAlbumDislike).toHaveBeenCalledWith(2);

    h.toggleArtistLike(1);
    expect(state.artists[0].liked).toBe(1);
    expect(deps.onToggleArtistLike).toHaveBeenCalledWith(1);
    expect(setResults).toHaveBeenCalledTimes(2);
  });
});
