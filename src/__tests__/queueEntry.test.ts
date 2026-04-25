import { describe, it, expect } from "vitest";
import {
  trackToQueueEntry,
  queueEntryToTrack,
  parseUrlScheme,
  isRemoteTrack,
  remoteId,
  type QueueEntry,
} from "../queueEntry";
import type { Track } from "../types";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    key: "lib:1",
    path: "file:///test.mp3",
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
    liked: 0,
    youtube_url: null,
    added_at: null,
    modified_at: null,
    ...overrides,
  };
}

describe("isRemoteTrack", () => {
  it("returns true for subsonic:// path", () => {
    expect(isRemoteTrack(makeTrack({ path: "subsonic://server.com/abc" }))).toBe(true);
  });

  it("returns true for tidal:// path", () => {
    expect(isRemoteTrack(makeTrack({ path: "tidal://12345" }))).toBe(true);
  });

  it("returns false for local file path", () => {
    expect(isRemoteTrack(makeTrack({ path: "file:///music/song.mp3" }))).toBe(false);
  });
});

describe("remoteId", () => {
  it("extracts id from subsonic:// path", () => {
    expect(remoteId(makeTrack({ path: "subsonic://server.com/abc123" }))).toBe("abc123");
  });

  it("extracts id from tidal:// path", () => {
    expect(remoteId(makeTrack({ path: "tidal://12345" }))).toBe("12345");
  });

  it("returns null for local path", () => {
    expect(remoteId(makeTrack({ path: "file:///music/song.mp3" }))).toBeNull();
  });

  it("returns null for subsonic:// with no id segment", () => {
    expect(remoteId(makeTrack({ path: "subsonic://server.com/" }))).toBeNull();
  });
});

describe("trackToQueueEntry", () => {
  it("converts track to QueueEntry with path as url", () => {
    const track = makeTrack({
      path: "file:///music/artist/album/track.mp3",
      title: "My Song",
      artist_name: "Artist",
      album_title: "Album",
      duration_secs: 180,
      track_number: 3,
      year: 2020,
      format: "mp3",
    });
    const entry = trackToQueueEntry(track);
    expect(entry).toEqual({
      url: "file:///music/artist/album/track.mp3",
      key: "lib:1",
      title: "My Song",
      artist_name: "Artist",
      album_title: "Album",
      duration_secs: 180,
      track_number: 3,
      year: 2020,
      format: "mp3",
      image_url: undefined,
      liked: 0,
    });
  });

  it("handles null metadata fields", () => {
    const track = makeTrack({
      path: "file:///unknown.mp3",
      title: "Unknown",
    });
    const entry = trackToQueueEntry(track);
    expect(entry).toEqual({
      url: "file:///unknown.mp3",
      key: "lib:1",
      title: "Unknown",
      artist_name: null,
      album_title: null,
      duration_secs: null,
      track_number: null,
      year: null,
      format: null,
      image_url: undefined,
      liked: 0,
    });
  });

  it("uses tidal:// path for TIDAL tracks", () => {
    const track = makeTrack({
      path: "tidal://tidal-id",
      title: "TIDAL Song",
    });
    const entry = trackToQueueEntry(track);
    expect(entry.url).toBe("tidal://tidal-id");
  });

  it("uses subsonic:// path for Subsonic tracks", () => {
    const track = makeTrack({
      path: "subsonic://server.com/sub-id",
      title: "Server Song",
    });
    const entry = trackToQueueEntry(track);
    expect(entry.url).toBe("subsonic://server.com/sub-id");
  });

  it("includes liked state in QueueEntry", () => {
    const track = makeTrack({ liked: 1 });
    const entry = trackToQueueEntry(track);
    expect(entry.liked).toBe(1);
  });
});

describe("queueEntryToTrack", () => {
  it("converts file:// url to Track with null id and generated key", () => {
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
    expect(track.id).toBeNull();
    expect(track.key).toMatch(/^ext:\d+$/);
    expect(track.path).toBe("file:///music/song.mp3");
    expect(track.title).toBe("Song");
    expect(track.artist_name).toBe("Artist");
    expect(track.album_title).toBe("Album");
    expect(track.duration_secs).toBe(200);
    expect(track.format).toBe("mp3");
  });

  it("converts tidal:// url to Track with null id and generated key", () => {
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
    expect(track.id).toBeNull();
    expect(track.key).toMatch(/^ext:\d+$/);
    expect(track.path).toBe("tidal://12345");
    expect(track.title).toBe("TIDAL Song");
    expect(track.artist_name).toBe("TIDAL Artist");
  });

  it("assigns unique keys for multiple entries", () => {
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
    expect(track1.key).not.toBe(track2.key);
    expect(track1.id).toBeNull();
    expect(track2.id).toBeNull();
  });

  it("converts subsonic:// url to Track with null id", () => {
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
    expect(track.id).toBeNull();
    expect(track.key).toMatch(/^ext:\d+$/);
    expect(track.path).toBe("subsonic://server.com/abc123");
    expect(track.title).toBe("Server Song");
    expect(track.artist_name).toBe("Server Artist");
  });

  it("preserves key from QueueEntry when present", () => {
    const entry: QueueEntry = {
      url: "tidal://12345",
      key: "ext:42",
      title: "Song",
      artist_name: null,
      album_title: null,
      duration_secs: null,
      track_number: null,
      year: null,
      format: null,
    };
    const track = queueEntryToTrack(entry);
    expect(track.key).toBe("ext:42");
  });

  it("preserves liked state from QueueEntry", () => {
    const entry: QueueEntry = {
      url: "tidal://99999",
      key: "ext:99",
      title: "Liked TIDAL Song",
      artist_name: null,
      album_title: null,
      duration_secs: null,
      track_number: null,
      year: null,
      format: null,
      liked: 1,
    };
    const track = queueEntryToTrack(entry);
    expect(track.liked).toBe(1);
  });

  it("defaults liked to 0 when not present in QueueEntry", () => {
    const entry: QueueEntry = {
      url: "file:///music/song.mp3",
      title: "Song",
      artist_name: null,
      album_title: null,
      duration_secs: null,
      track_number: null,
      year: null,
      format: null,
    };
    const track = queueEntryToTrack(entry);
    expect(track.liked).toBe(0);
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

  it("returns unknown for unrecognized scheme", () => {
    const result = parseUrlScheme("spotify://track/abc123");
    expect(result).toEqual({ scheme: "unknown", url: "spotify://track/abc123" });
  });

  it("returns unknown for http:// URLs", () => {
    const result = parseUrlScheme("http://example.com/track.mp3");
    expect(result).toEqual({ scheme: "unknown", url: "http://example.com/track.mp3" });
  });

  it("returns unknown for https:// URLs", () => {
    const result = parseUrlScheme("https://example.com/track.mp3");
    expect(result).toEqual({ scheme: "unknown", url: "https://example.com/track.mp3" });
  });

  it("handles plain path as file", () => {
    const result = parseUrlScheme("/music/song.mp3");
    expect(result).toEqual({ scheme: "file", path: "/music/song.mp3" });
  });

  it("parses external:// scheme", () => {
    const result = parseUrlScheme("external://");
    expect(result).toEqual({ scheme: "external" });
  });

  it("parses external:// with suffix", () => {
    const result = parseUrlScheme("external://yt/abc");
    expect(result).toEqual({ scheme: "external" });
  });
});
