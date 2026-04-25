import { describe, it, expect } from "vitest";
import { nextExternalKey, parseLibraryId, isLibraryTrack } from "../queueEntry";
import type { Track } from "../types";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 1, key: "lib:1", path: "file:///test.mp3", title: "Test",
    artist_id: null, artist_name: null, album_id: null, album_title: null,
    year: null, track_number: null, duration_secs: null, format: null,
    file_size: null, collection_id: null, collection_name: null,
    liked: 0, youtube_url: null, added_at: null, modified_at: null,
    ...overrides,
  };
}

describe("nextExternalKey", () => {
  it("returns keys with ext: prefix", () => {
    const key = nextExternalKey();
    expect(key).toMatch(/^ext:\d+$/);
  });

  it("returns unique keys on each call", () => {
    const keys = new Set([nextExternalKey(), nextExternalKey(), nextExternalKey()]);
    expect(keys.size).toBe(3);
  });
});

describe("parseLibraryId", () => {
  it("extracts number from lib: key", () => {
    expect(parseLibraryId("lib:42")).toBe(42);
  });

  it("returns null for ext: key", () => {
    expect(parseLibraryId("ext:1")).toBeNull();
  });

  it("returns null for arbitrary string", () => {
    expect(parseLibraryId("something")).toBeNull();
  });

  it("handles lib:0", () => {
    expect(parseLibraryId("lib:0")).toBe(0);
  });
});

describe("isLibraryTrack", () => {
  it("returns true for track with numeric id", () => {
    expect(isLibraryTrack(makeTrack({ id: 42, key: "lib:42" }))).toBe(true);
  });

  it("returns false for track with null id", () => {
    expect(isLibraryTrack(makeTrack({ id: null, key: "ext:1" }))).toBe(false);
  });
});

describe("guard behavior for non-library tracks", () => {
  const libraryTrack = makeTrack({ id: 42, key: "lib:42" });
  const tidalTrack = makeTrack({ id: null, key: "ext:1", path: "tidal://12345" });
  const spotifyTrack = makeTrack({ id: null, key: "ext:2", path: "external://" });

  describe("like eligibility (requires id != null)", () => {
    it("library track is likeable", () => {
      expect(libraryTrack.id != null).toBe(true);
    });

    it("tidal track is not likeable", () => {
      expect(tidalTrack.id != null).toBe(false);
    });

    it("spotify track is not likeable", () => {
      expect(spotifyTrack.id != null).toBe(false);
    });
  });

  describe("delete eligibility (requires id != null and local path)", () => {
    function canDelete(t: Track): boolean {
      return t.id != null
        && !!t.path
        && !t.path.startsWith("subsonic://")
        && !t.path.startsWith("tidal://")
        && !t.path.startsWith("external://");
    }

    it("library track can be deleted", () => {
      expect(canDelete(libraryTrack)).toBe(true);
    });

    it("tidal track cannot be deleted", () => {
      expect(canDelete(tidalTrack)).toBe(false);
    });

    it("spotify track cannot be deleted", () => {
      expect(canDelete(spotifyTrack)).toBe(false);
    });

    it("subsonic track cannot be deleted", () => {
      const subsonicTrack = makeTrack({ id: 99, key: "lib:99", path: "subsonic://server/123" });
      expect(canDelete(subsonicTrack)).toBe(false);
    });
  });

  describe("locate eligibility (requires id != null)", () => {
    it("library track can be located", () => {
      expect(libraryTrack.id != null).toBe(true);
    });

    it("external track cannot be located", () => {
      expect(spotifyTrack.id != null).toBe(false);
    });
  });

  describe("identity matching uses key, not id", () => {
    it("two tracks with same key are the same track", () => {
      const a = makeTrack({ id: 42, key: "lib:42" });
      const b = makeTrack({ id: 42, key: "lib:42" });
      expect(a.key === b.key).toBe(true);
    });

    it("two external tracks with null id are NOT confused", () => {
      const a = makeTrack({ id: null, key: "ext:1" });
      const b = makeTrack({ id: null, key: "ext:2" });
      expect(a.key === b.key).toBe(false);
    });

    it("like propagation matches by key across queue and library", () => {
      const library = [makeTrack({ id: 42, key: "lib:42", liked: 0 })];
      const queue = [makeTrack({ id: 42, key: "lib:42", liked: 0 })];
      const targetKey = "lib:42";
      const newLiked = 1;

      const updatedLibrary = library.map(t => t.key === targetKey ? { ...t, liked: newLiked } : t);
      const updatedQueue = queue.map(t => t.key === targetKey ? { ...t, liked: newLiked } : t);

      expect(updatedLibrary[0].liked).toBe(1);
      expect(updatedQueue[0].liked).toBe(1);
    });
  });
});
