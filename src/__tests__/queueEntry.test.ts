import { describe, it, expect } from "vitest";
import {
  computeUrl,
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
    relative_path: null,
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

describe("computeUrl", () => {
  it("returns file:// path as-is for local track", () => {
    const track = makeTrack({ path: "file:///music/song.mp3" });
    expect(computeUrl(track, [])).toBe("file:///music/song.mp3");
  });

  it("returns tidal:// path as-is for TIDAL track", () => {
    const track = makeTrack({ path: "tidal://12345" });
    expect(computeUrl(track, [])).toBe("tidal://12345");
  });

  it("returns subsonic:// path as-is for Subsonic track", () => {
    const track = makeTrack({ path: "subsonic://demo.navidrome.org/abc123" });
    expect(computeUrl(track, [])).toBe("subsonic://demo.navidrome.org/abc123");
  });

  it("returns pre-stamped url if present", () => {
    const track = makeTrack({ path: "file:///music/song.mp3", url: "tidal://override" });
    expect(computeUrl(track, [])).toBe("tidal://override");
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
      path: "file:///unknown.mp3",
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

  it("uses tidal:// path for TIDAL tracks", () => {
    const track = makeTrack({
      path: "tidal://tidal-id",
      title: "TIDAL Song",
    });
    const entry = trackToQueueEntry(track, []);
    expect(entry.url).toBe("tidal://tidal-id");
  });

  it("uses subsonic:// path for Subsonic tracks", () => {
    const track = makeTrack({
      path: "subsonic://server.com/sub-id",
      title: "Server Song",
    });
    const entry = trackToQueueEntry(track, []);
    expect(entry.url).toBe("subsonic://server.com/sub-id");
  });

  it("uses pre-stamped url from track if present", () => {
    const track = makeTrack({
      path: "file:///music/song.mp3",
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
      path: "file:///music/song.mp3",
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
      liked: 0,
      youtube_url: null,
      added_at: null,
      modified_at: null,
      relative_path: null,
      url: "file:///music/song.mp3",
    });
  });

  it("converts tidal:// url to Track with negative id and tidal path", () => {
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
    expect(track.path).toBe("tidal://12345");
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

  it("converts subsonic:// url to Track with subsonic path", () => {
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
      path: "subsonic://server.com/abc123",
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
      liked: 0,
      youtube_url: null,
      added_at: null,
      modified_at: null,
      relative_path: null,
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
    expect(track.path).toBe("subsonic://server.com");
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
});
