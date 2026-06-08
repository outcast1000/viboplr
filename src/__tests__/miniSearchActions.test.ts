import { describe, it, expect, vi } from "vitest";
import { routeMiniSearchAction } from "../hooks/useMiniSearch";
import type { Track, Album, Artist, SearchResultItem } from "../types";

function makeTrack(): Track {
  return {
    id: 1, key: "lib:1", path: "file:///a.mp3", title: "Song", artist_id: 2,
    artist_name: "Artist", album_id: 3, album_title: "Album", year: 2020,
    duration_secs: 100, format: "mp3", collection_id: 1, collection_name: "Local",
    liked: 0, track_number: null, disc_number: null, play_count: 0, last_played_at: null,
    youtube_url: null, added_at: null, file_size: null, bitrate: null, sample_rate: null,
    bit_depth: null, channels: null,
  } as unknown as Track;
}
const album: Album = { id: 3, title: "Album", artist_id: 2, artist_name: "Artist", year: 2020, track_count: 10, liked: 0 } as Album;
const artist: Artist = { id: 2, name: "Artist", track_count: 20, liked: 0 } as Artist;

function deps() {
  return {
    onPlayTrack: vi.fn(), onEnqueueTrack: vi.fn(),
    playAlbum: vi.fn(), enqueueAlbum: vi.fn(),
    playArtist: vi.fn(), enqueueArtist: vi.fn(),
  };
}

describe("routeMiniSearchAction", () => {
  it("track + play → onPlayTrack", () => {
    const d = deps();
    const t = makeTrack();
    routeMiniSearchAction({ kind: "track", data: t } as SearchResultItem, false, d);
    expect(d.onPlayTrack).toHaveBeenCalledWith(t);
    expect(d.onEnqueueTrack).not.toHaveBeenCalled();
  });

  it("track + enqueue → onEnqueueTrack", () => {
    const d = deps();
    const t = makeTrack();
    routeMiniSearchAction({ kind: "track", data: t } as SearchResultItem, true, d);
    expect(d.onEnqueueTrack).toHaveBeenCalledWith(t);
  });

  it("album + play → playAlbum(id); + enqueue → enqueueAlbum(id)", () => {
    const d = deps();
    routeMiniSearchAction({ kind: "album", data: album } as SearchResultItem, false, d);
    expect(d.playAlbum).toHaveBeenCalledWith(3);
    routeMiniSearchAction({ kind: "album", data: album } as SearchResultItem, true, d);
    expect(d.enqueueAlbum).toHaveBeenCalledWith(3);
  });

  it("artist + play → playArtist(id); + enqueue → enqueueArtist(id)", () => {
    const d = deps();
    routeMiniSearchAction({ kind: "artist", data: artist } as SearchResultItem, false, d);
    expect(d.playArtist).toHaveBeenCalledWith(2);
    routeMiniSearchAction({ kind: "artist", data: artist } as SearchResultItem, true, d);
    expect(d.enqueueArtist).toHaveBeenCalledWith(2);
  });
});
