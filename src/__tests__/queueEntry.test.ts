import { describe, it, expect } from "vitest";
import {
  computeLocation,
  trackToQueueEntry,
  queueEntryToTrack,
  parseLocationScheme,
  type QueueEntry,
  type ParsedLocation,
} from "../queueEntry";
import type { Track, Collection } from "../types";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    path: "/test.mp3",
    title: "Test",
    artist_id: null,
    artist_name: null,
    album_id: null,
    album_title: null,
    year: null,
    track_number: null,
    duration_secs: null,
    format: null,
    file_size: null,
    collection_id: null,
    collection_name: null,
    subsonic_id: null,
    liked: 0,
    youtube_url: null,
    added_at: null,
    modified_at: null,
    ...overrides,
  };
}

function makeCollection(overrides: Partial<Collection> = {}): Collection {
  return {
    id: 1,
    kind: "local",
    name: "Test Collection",
    path: "/music",
    url: null,
    username: null,
    last_synced_at: null,
    auto_update: false,
    auto_update_interval_mins: 60,
    enabled: true,
    last_sync_duration_secs: null,
    last_sync_error: null,
    ...overrides,
  };
}

describe("computeLocation", () => {
  it("returns file:// for local track with no subsonic_id", () => {
    const track = makeTrack({ path: "/music/song.mp3", subsonic_id: null });
    expect(computeLocation(track, [])).toBe("file:///music/song.mp3");
  });

  it("returns tidal:// for ephemeral TIDAL track (empty path + subsonic_id)", () => {
    const track = makeTrack({ path: "", subsonic_id: "12345" });
    expect(computeLocation(track, [])).toBe("tidal://12345");
  });

  it("returns tidal:// for track in TIDAL collection", () => {
    const track = makeTrack({
      collection_id: 1,
      subsonic_id: "67890",
      path: "/some/path",
    });
    const collections = [makeCollection({ id: 1, kind: "tidal" })];
    expect(computeLocation(track, collections)).toBe("tidal://67890");
  });

  it("returns subsonic:// for track in Subsonic collection", () => {
    const track = makeTrack({
      collection_id: 2,
      subsonic_id: "abc123",
    });
    const collections = [
      makeCollection({
        id: 2,
        kind: "subsonic",
        url: "https://demo.navidrome.org/",
      }),
    ];
    expect(computeLocation(track, collections)).toBe(
      "subsonic://demo.navidrome.org/rest/stream.view?id=abc123"
    );
  });

  it("strips https:// and trailing slash from Subsonic URL", () => {
    const track = makeTrack({
      collection_id: 3,
      subsonic_id: "xyz",
    });
    const collections = [
      makeCollection({
        id: 3,
        kind: "subsonic",
        url: "https://music.example.com:4533/subsonic",
      }),
    ];
    expect(computeLocation(track, collections)).toBe(
      "subsonic://music.example.com:4533/subsonic/rest/stream.view?id=xyz"
    );
  });

  it("falls back to file:// when collection not found", () => {
    const track = makeTrack({
      collection_id: 999,
      path: "/fallback.mp3",
    });
    expect(computeLocation(track, [])).toBe("file:///fallback.mp3");
  });

  it("falls back to file:// for local collection kind", () => {
    const track = makeTrack({
      collection_id: 1,
      path: "/local/track.flac",
    });
    const collections = [makeCollection({ id: 1, kind: "local" })];
    expect(computeLocation(track, collections)).toBe("file:///local/track.flac");
  });

  it("falls back to file:// for seed collection kind", () => {
    const track = makeTrack({
      collection_id: 1,
      path: "/seed/track.mp3",
    });
    const collections = [makeCollection({ id: 1, kind: "seed" })];
    expect(computeLocation(track, collections)).toBe("file:///seed/track.mp3");
  });
});

describe("trackToQueueEntry", () => {
  it("converts track to QueueEntry with computed location", () => {
    const track = makeTrack({
      path: "/music/artist/album/track.mp3",
      title: "My Song",
      artist_name: "Artist",
      album_title: "Album",
      duration_secs: 180,
      track_number: 3,
      year: 2020,
      format: "mp3",
    });
    const entry = trackToQueueEntry(track, []);
    expect(entry).toEqual({
      location: "file:///music/artist/album/track.mp3",
      title: "My Song",
      artist_name: "Artist",
      album_title: "Album",
      duration_secs: 180,
      track_number: 3,
      year: 2020,
      format: "mp3",
    });
  });

  it("handles null metadata fields", () => {
    const track = makeTrack({
      path: "/unknown.mp3",
      title: "Unknown",
    });
    const entry = trackToQueueEntry(track, []);
    expect(entry).toEqual({
      location: "file:///unknown.mp3",
      title: "Unknown",
      artist_name: null,
      album_title: null,
      duration_secs: null,
      track_number: null,
      year: null,
      format: null,
    });
  });

  it("uses tidal:// location for TIDAL tracks", () => {
    const track = makeTrack({
      path: "",
      subsonic_id: "tidal-id",
      title: "TIDAL Song",
    });
    const entry = trackToQueueEntry(track, []);
    expect(entry.location).toBe("tidal://tidal-id");
  });

  it("uses subsonic:// location for Subsonic tracks", () => {
    const track = makeTrack({
      collection_id: 5,
      subsonic_id: "sub-id",
      title: "Server Song",
    });
    const collections = [
      makeCollection({
        id: 5,
        kind: "subsonic",
        url: "https://server.com",
      }),
    ];
    const entry = trackToQueueEntry(track, collections);
    expect(entry.location).toBe("subsonic://server.com/rest/stream.view?id=sub-id");
  });
});

describe("queueEntryToTrack", () => {
  it("converts file:// location to Track with path", () => {
    const entry: QueueEntry = {
      location: "file:///music/song.mp3",
      title: "Song",
      artist_name: "Artist",
      album_title: "Album",
      duration_secs: 200,
      track_number: 1,
      year: 2021,
      format: "mp3",
    };
    const track = queueEntryToTrack(entry);
    expect(track).toEqual({
      id: 0,
      path: "/music/song.mp3",
      title: "Song",
      artist_id: null,
      artist_name: "Artist",
      album_id: null,
      album_title: "Album",
      year: 2021,
      track_number: 1,
      duration_secs: 200,
      format: "mp3",
      file_size: null,
      collection_id: null,
      collection_name: null,
      subsonic_id: null,
      liked: 0,
      youtube_url: null,
      added_at: null,
      modified_at: null,
    });
  });

  it("converts tidal:// location to Track with negative id and subsonic_id", () => {
    const entry: QueueEntry = {
      location: "tidal://12345",
      title: "TIDAL Song",
      artist_name: "TIDAL Artist",
      album_title: null,
      duration_secs: 240,
      track_number: null,
      year: null,
      format: null,
    };
    const track = queueEntryToTrack(entry);
    expect(track.id).toBeLessThan(0);
    expect(track.path).toBe("");
    expect(track.subsonic_id).toBe("12345");
    expect(track.title).toBe("TIDAL Song");
    expect(track.artist_name).toBe("TIDAL Artist");
  });

  it("assigns unique negative ids for multiple tidal:// entries", () => {
    const entry1: QueueEntry = {
      location: "tidal://111",
      title: "Song 1",
      artist_name: null,
      album_title: null,
      duration_secs: null,
      track_number: null,
      year: null,
      format: null,
    };
    const entry2: QueueEntry = {
      location: "tidal://222",
      title: "Song 2",
      artist_name: null,
      album_title: null,
      duration_secs: null,
      track_number: null,
      year: null,
      format: null,
    };
    const track1 = queueEntryToTrack(entry1);
    const track2 = queueEntryToTrack(entry2);
    expect(track1.id).not.toBe(track2.id);
    expect(track1.id).toBeLessThan(0);
    expect(track2.id).toBeLessThan(0);
  });

  it("converts subsonic:// location to Track with id=0 and subsonic_id", () => {
    const entry: QueueEntry = {
      location: "subsonic://server.com/rest/stream.view?id=abc123",
      title: "Server Song",
      artist_name: "Server Artist",
      album_title: "Server Album",
      duration_secs: 300,
      track_number: 5,
      year: 2022,
      format: "flac",
    };
    const track = queueEntryToTrack(entry);
    expect(track).toEqual({
      id: 0,
      path: "",
      title: "Server Song",
      artist_id: null,
      artist_name: "Server Artist",
      album_id: null,
      album_title: "Server Album",
      year: 2022,
      track_number: 5,
      duration_secs: 300,
      format: "flac",
      file_size: null,
      collection_id: null,
      collection_name: null,
      subsonic_id: "abc123",
      liked: 0,
      youtube_url: null,
      added_at: null,
      modified_at: null,
    });
  });

  it("handles subsonic:// URL without query params", () => {
    const entry: QueueEntry = {
      location: "subsonic://server.com/rest/stream.view",
      title: "Song",
      artist_name: null,
      album_title: null,
      duration_secs: null,
      track_number: null,
      year: null,
      format: null,
    };
    const track = queueEntryToTrack(entry);
    expect(track.id).toBe(0);
    expect(track.subsonic_id).toBeNull();
  });
});

describe("parseLocationScheme", () => {
  it("parses file:// scheme", () => {
    const result = parseLocationScheme("file:///music/song.mp3");
    expect(result).toEqual({ scheme: "file", path: "/music/song.mp3" });
  });

  it("parses tidal:// scheme", () => {
    const result = parseLocationScheme("tidal://12345");
    expect(result).toEqual({ scheme: "tidal", id: "12345" });
  });

  it("parses subsonic:// scheme with full URL and id", () => {
    const result = parseLocationScheme(
      "subsonic://server.com/rest/stream.view?id=abc123"
    );
    expect(result).toEqual({
      scheme: "subsonic",
      url: "subsonic://server.com/rest/stream.view?id=abc123",
      id: "abc123",
    });
  });

  it("parses subsonic:// scheme without id param", () => {
    const result = parseLocationScheme("subsonic://server.com/rest/stream.view");
    expect(result).toEqual({
      scheme: "subsonic",
      url: "subsonic://server.com/rest/stream.view",
      id: "",
    });
  });

  it("parses subsonic:// scheme with multiple query params", () => {
    const result = parseLocationScheme(
      "subsonic://server.com/path?foo=bar&id=xyz&baz=qux"
    );
    expect(result).toEqual({
      scheme: "subsonic",
      url: "subsonic://server.com/path?foo=bar&id=xyz&baz=qux",
      id: "xyz",
    });
  });

  it("handles file:// with Windows-style path", () => {
    const result = parseLocationScheme("file://C:/Users/Music/song.mp3");
    expect(result).toEqual({ scheme: "file", path: "C:/Users/Music/song.mp3" });
  });

  it("handles unknown scheme as file", () => {
    const result = parseLocationScheme("unknown://something");
    expect(result).toEqual({ scheme: "file", path: "unknown://something" });
  });

  it("handles plain path as file", () => {
    const result = parseLocationScheme("/music/song.mp3");
    expect(result).toEqual({ scheme: "file", path: "/music/song.mp3" });
  });
});
