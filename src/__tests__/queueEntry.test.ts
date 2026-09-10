import { describe, it, expect } from "vitest";
import {
  trackToQueueEntry,
  trackToQueueTrack,
  pluginTrackToQueueTrack,
  parseUrlScheme,
  isLocalTrack,
  effectiveLocalPath,
  isRemoteTrack,
  isNetworkSharePath,
  isRemoteScheme,
  remoteId,
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
    added_at: null,
    modified_at: null,
    ...overrides,
  };
}

describe("isRemoteScheme", () => {
  it("returns true for tidal:// URLs", () => {
    expect(isRemoteScheme("tidal://123/456")).toBe(true);
  });

  it("returns true for subsonic:// URLs", () => {
    expect(isRemoteScheme("subsonic://server.com/123")).toBe(true);
  });

  it("returns false for file:// URLs", () => {
    expect(isRemoteScheme("file:///path/to/song.mp3")).toBe(false);
  });

  it("returns false for http/https URLs", () => {
    expect(isRemoteScheme("https://cdn.example.com/stream")).toBe(false);
  });

  it("returns false for paths without scheme", () => {
    expect(isRemoteScheme("/path/to/song.mp3")).toBe(false);
  });
});

describe("isLocalTrack", () => {
  it("returns true for file:// path", () => {
    expect(isLocalTrack(makeTrack({ path: "file:///music/song.mp3" }))).toBe(true);
  });

  it("returns false for subsonic:// path", () => {
    expect(isLocalTrack(makeTrack({ path: "subsonic://server.com/abc" }))).toBe(false);
  });

  it("returns false for plugin scheme path", () => {
    expect(isLocalTrack(makeTrack({ path: "tidal://12345" }))).toBe(false);
  });

  it("returns false for external:// path", () => {
    expect(isLocalTrack(makeTrack({ path: "external://yt/abc" }))).toBe(false);
  });

  it("returns false for null path", () => {
    expect(isLocalTrack(makeTrack({ path: null }))).toBe(false);
  });

  it("returns false for empty string path", () => {
    expect(isLocalTrack(makeTrack({ path: "" }))).toBe(false);
  });
});

describe("isRemoteTrack", () => {
  it("returns true for subsonic:// path", () => {
    expect(isRemoteTrack(makeTrack({ path: "subsonic://server.com/abc" }))).toBe(true);
  });

  it("returns true for plugin scheme path", () => {
    expect(isRemoteTrack(makeTrack({ path: "tidal://12345" }))).toBe(true);
  });

  it("returns true for external:// path", () => {
    expect(isRemoteTrack(makeTrack({ path: "external://yt/abc" }))).toBe(true);
  });

  it("returns true for http:// path", () => {
    expect(isRemoteTrack(makeTrack({ path: "http://example.com/track.mp3" }))).toBe(true);
  });

  it("returns false for file:// path", () => {
    expect(isRemoteTrack(makeTrack({ path: "file:///music/song.mp3" }))).toBe(false);
  });

  it("returns false for null path", () => {
    expect(isRemoteTrack(makeTrack({ path: null }))).toBe(false);
  });

  it("returns false for empty string path", () => {
    expect(isRemoteTrack(makeTrack({ path: "" }))).toBe(false);
  });

  it("returns true for arbitrary unknown scheme", () => {
    expect(isRemoteTrack(makeTrack({ path: "foo://bar" }))).toBe(true);
  });
});

describe("isNetworkSharePath", () => {
  it("detects a Windows UNC path behind file://", () => {
    expect(isNetworkSharePath("file://\\\\server\\share\\song.mp3")).toBe(true);
  });

  it("detects a forward-slash UNC path behind file://", () => {
    expect(isNetworkSharePath("file:////server/share/song.mp3")).toBe(true);
  });

  it("detects a bare UNC path (no file:// prefix)", () => {
    expect(isNetworkSharePath("\\\\server\\share\\song.mp3")).toBe(true);
  });

  it("returns false for a local Windows drive", () => {
    expect(isNetworkSharePath("file://C:\\Music\\song.mp3")).toBe(false);
  });

  it("returns false for a POSIX file:/// path", () => {
    expect(isNetworkSharePath("file:///Users/alex/song.mp3")).toBe(false);
  });

  it("returns false for null / empty", () => {
    expect(isNetworkSharePath(null)).toBe(false);
    expect(isNetworkSharePath(undefined)).toBe(false);
    expect(isNetworkSharePath("")).toBe(false);
  });
});

describe("remoteId", () => {
  it("extracts id from subsonic:// path", () => {
    expect(remoteId(makeTrack({ path: "subsonic://server.com/abc123" }))).toBe("abc123");
  });

  it("extracts id from plugin scheme path", () => {
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
      // A library Track carries no render key; only a QueueTrack contributes one.
      key: undefined,
      album_artist_name: undefined,
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
      key: undefined,
      album_artist_name: undefined,
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

  it("uses plugin scheme path for plugin tracks", () => {
    const track = makeTrack({
      path: "tidal://tidal-id",
      title: "Plugin Song",
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

describe("parseUrlScheme", () => {
  it("parses file:// scheme", () => {
    const result = parseUrlScheme("file:///music/song.mp3");
    expect(result).toEqual({ scheme: "file", path: "/music/song.mp3" });
  });

  it("parses tidal:// as plugin scheme", () => {
    const result = parseUrlScheme("tidal://12345");
    expect(result).toEqual({ scheme: "plugin", protocol: "tidal", id: "12345" });
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

  it("parses spotify:// as plugin scheme", () => {
    const result = parseUrlScheme("spotify://4uLU6hMCjMI75M1A2tKUQC");
    expect(result).toEqual({ scheme: "plugin", protocol: "spotify", id: "4uLU6hMCjMI75M1A2tKUQC" });
  });

  it("parses arbitrary plugin scheme", () => {
    const result = parseUrlScheme("magnet://some-hash");
    expect(result).toEqual({ scheme: "plugin", protocol: "magnet", id: "some-hash" });
  });

  it("parses http:// as plugin scheme with http protocol", () => {
    const result = parseUrlScheme("http://example.com/track.mp3");
    expect(result).toEqual({ scheme: "plugin", protocol: "http", id: "example.com/track.mp3" });
  });

  it("parses https:// as plugin scheme with https protocol", () => {
    const result = parseUrlScheme("https://example.com/track.mp3");
    expect(result).toEqual({ scheme: "plugin", protocol: "https", id: "example.com/track.mp3" });
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

describe("trackToQueueTrack", () => {
  it("strips DB IDs and keeps metadata", () => {
    const track: Track = {
      id: 42,
      path: "file:///music/song.mp3",
      title: "Test Song",
      artist_id: 5,
      artist_name: "Artist",
      album_id: 10,
      album_title: "Album",
      year: 2020,
      track_number: 3,
      duration_secs: 240,
      format: "mp3",
      file_size: 5000000,
      collection_id: 1,
      collection_name: "Music",
      liked: 1,
      added_at: 1000,
      modified_at: 2000,
      image_url: "/path/to/image.jpg",
    };

    const qt = trackToQueueTrack(track);

    // A fresh queue key, not the library row's: two copies of one track are
    // two entries by construction, and nothing downstream may read the row id
    // back out of a key. The id is carried as a number instead.
    expect(qt.key).toMatch(/^q:\d+$/);
    expect(qt.libraryId).toBe(42);
    expect(qt.path).toBe("file:///music/song.mp3");
    expect(qt.title).toBe("Test Song");
    expect(qt.artist_name).toBe("Artist");
    expect(qt.album_title).toBe("Album");
    expect(qt.duration_secs).toBe(240);
    expect(qt.format).toBe("mp3");
    expect(qt.image_url).toBe("/path/to/image.jpg");
    expect(qt.liked).toBe(1);
    // Verify no DB IDs or collection_id exist on the result
    expect("id" in qt).toBe(false);
    expect("album_id" in qt).toBe(false);
    expect("artist_id" in qt).toBe(false);
    expect("collection_id" in qt).toBe(false);
  });
});

describe("effectiveLocalPath", () => {
  it("returns the bare path for a file:// track", () => {
    expect(effectiveLocalPath({ path: "file:///music/song.flac" }, null))
      .toBe("/music/song.flac");
  });

  // The case this exists for: a plugin scheme whose resolver reports a real
  // file. Reading the track's own scheme said "remote" and cost it every fact
  // a tag reader can supply — a 24-bit FLAC from qBittorrent reported only its
  // sample rate, from the decoder.
  it("follows a resolver that reported a file:// source", () => {
    expect(effectiveLocalPath(
      { path: "qbt://abc123/3" },
      { name: "qBittorrent", sourceUrl: "file://D:/Torrents/In Rainbows/03 - Nude.flac" },
    )).toBe("D:/Torrents/In Rainbows/03 - Nude.flac");
  });

  it("follows a Library win on a local copy (file://-prefixed like any resolver)", () => {
    expect(effectiveLocalPath({ path: "ext:7" }, { name: "Library", sourceUrl: "file:///music/song.flac" }))
      .toBe("/music/song.flac");
  });

  it("is null for anything genuinely remote", () => {
    expect(effectiveLocalPath({ path: "subsonic://1/42" }, null)).toBeNull();
    expect(effectiveLocalPath(
      { path: "ytdlp://x" },
      { name: "yt-dlp", sourceUrl: "https://www.youtube.com/watch?v=x" },
    )).toBeNull();
    // A Library win on a NETWORK copy attributes to that copy's own URI — not
    // a path; passing it to Open folder or a tag read would be nonsense.
    expect(effectiveLocalPath({ path: "ext:7" }, { name: "Library", sourceUrl: "subsonic://host/42" }))
      .toBeNull();
    expect(effectiveLocalPath({ path: null }, null)).toBeNull();
  });
});

// Plugin tracks entering the queue: the kind→format stamp.
describe("pluginTrackToQueueTrack", () => {
  it("stamps a provisional mp4 for a declared video, so the row classifies pre-play", () => {
    const qt = pluginTrackToQueueTrack({ path: "qbt://aaa/3", title: "Clip", kind: "video" });
    expect(qt.format).toBe("mp4");
    expect(qt.path).toBe("qbt://aaa/3");
    expect(qt.key).toMatch(/^q:/);
  });

  it("declares nothing when the plugin declared nothing — the resolve decides", () => {
    expect(pluginTrackToQueueTrack({ path: "qbt://aaa/3", title: "Song" }).format).toBeNull();
    expect(pluginTrackToQueueTrack({ path: "qbt://aaa/3", title: "Song", kind: "audio" }).format).toBeNull();
  });
});
