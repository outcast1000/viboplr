import { describe, it, expect } from "vitest";
import {
  computeUrl,
  trackToQueueEntry,
  queueEntryToTrack,
  parseUrlScheme,
  type QueueEntry,
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

describe("computeUrl", () => {
  it("returns file:// for local track with no subsonic_id", () => {
    const track = makeTrack({ path: "/music/song.mp3", subsonic_id: null });
    expect(computeUrl(track, [])).toBe("file:///music/song.mp3");
  });

  it("returns tidal:// for TIDAL track (empty path + subsonic_id)", () => {
    const track = makeTrack({ path: "", subsonic_id: "12345" });
    expect(computeUrl(track, [])).toBe("tidal://12345");
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
    expect(computeUrl(track, collections)).toBe(
      "subsonic://demo.navidrome.org/abc123"
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
    expect(computeUrl(track, collections)).toBe(
      "subsonic://music.example.com:4533/subsonic/xyz"
    );
  });

  it("falls back to file:// when collection not found", () => {
    const track = makeTrack({
      collection_id: 999,
      path: "/fallback.mp3",
    });
    expect(computeUrl(track, [])).toBe("file:///fallback.mp3");
  });

  it("falls back to file:// for local collection kind", () => {
    const track = makeTrack({
      collection_id: 1,
      path: "/local/track.flac",
    });
    const collections = [makeCollection({ id: 1, kind: "local" })];
    expect(computeUrl(track, collections)).toBe("file:///local/track.flac");
  });

  it("falls back to file:// for seed collection kind", () => {
    const track = makeTrack({
      collection_id: 1,
      path: "/seed/track.mp3",
    });
    const collections = [makeCollection({ id: 1, kind: "seed" })];
    expect(computeUrl(track, collections)).toBe("file:///seed/track.mp3");
  });
});

describe("trackToQueueEntry", () => {
  it("converts track to QueueEntry with computed url", () => {
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
      url: "file:///music/artist/album/track.mp3",
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
      url: "file:///unknown.mp3",
      title: "Unknown",
      artist_name: null,
      album_title: null,
      duration_secs: null,
      track_number: null,
      year: null,
      format: null,
    });
  });

  it("uses tidal:// url for TIDAL tracks", () => {
    const track = makeTrack({
      path: "",
      subsonic_id: "tidal-id",
      title: "TIDAL Song",
    });
    const entry = trackToQueueEntry(track, []);
    expect(entry.url).toBe("tidal://tidal-id");
  });

  it("uses subsonic:// url for Subsonic tracks", () => {
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
    expect(entry.url).toBe("subsonic://server.com/sub-id");
  });

  it("uses pre-stamped url from track if present", () => {
    const track = makeTrack({
      path: "/music/song.mp3",
      url: "tidal://override",
    });
    const entry = trackToQueueEntry(track, []);
    expect(entry.url).toBe("tidal://override");
  });
});

describe("queueEntryToTrack", () => {
  it("converts file:// url to Track with path", () => {
    const entry: QueueEntry = {
      url: "file:///music/song.mp3",
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
      url: "file:///music/song.mp3",
    });
  });

  it("converts tidal:// url to Track with negative id and subsonic_id", () => {
    const entry: QueueEntry = {
      url: "tidal://12345",
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
    expect(track.url).toBe("tidal://12345");
  });

  it("assigns unique negative ids for multiple tidal:// entries", () => {
    const entry1: QueueEntry = {
      url: "tidal://111",
      title: "Song 1",
      artist_name: null,
      album_title: null,
      duration_secs: null,
      track_number: null,
      year: null,
      format: null,
    };
    const entry2: QueueEntry = {
      url: "tidal://222",
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

  it("converts subsonic:// url to Track with id=0 and subsonic_id", () => {
    const entry: QueueEntry = {
      url: "subsonic://server.com/abc123",
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
      url: "subsonic://server.com/abc123",
    });
  });

  it("handles subsonic:// URL with host only (no track id)", () => {
    const entry: QueueEntry = {
      url: "subsonic://server.com",
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

describe("parseUrlScheme", () => {
  it("parses file:// scheme", () => {
    const result = parseUrlScheme("file:///music/song.mp3");
    expect(result).toEqual({ scheme: "file", path: "/music/song.mp3" });
  });

  it("parses tidal:// scheme", () => {
    const result = parseUrlScheme("tidal://12345");
    expect(result).toEqual({ scheme: "tidal", id: "12345" });
  });

  it("parses subsonic:// scheme with host and id", () => {
    const result = parseUrlScheme("subsonic://server.com/abc123");
    expect(result).toEqual({
      scheme: "subsonic",
      url: "subsonic://server.com/abc123",
      id: "abc123",
    });
  });

  it("parses subsonic:// scheme with host only (no id)", () => {
    const result = parseUrlScheme("subsonic://server.com");
    expect(result).toEqual({
      scheme: "subsonic",
      url: "subsonic://server.com",
      id: "",
    });
  });

  it("parses subsonic:// scheme with port and subpath", () => {
    const result = parseUrlScheme(
      "subsonic://music.example.com:4533/subsonic/xyz"
    );
    expect(result).toEqual({
      scheme: "subsonic",
      url: "subsonic://music.example.com:4533/subsonic/xyz",
      id: "xyz",
    });
  });

  it("handles file:// with Windows-style path", () => {
    const result = parseUrlScheme("file://C:/Users/Music/song.mp3");
    expect(result).toEqual({ scheme: "file", path: "C:/Users/Music/song.mp3" });
  });

  it("handles unknown scheme as file", () => {
    const result = parseUrlScheme("unknown://something");
    expect(result).toEqual({ scheme: "file", path: "unknown://something" });
  });

  it("handles plain path as file", () => {
    const result = parseUrlScheme("/music/song.mp3");
    expect(result).toEqual({ scheme: "file", path: "/music/song.mp3" });
  });
});
