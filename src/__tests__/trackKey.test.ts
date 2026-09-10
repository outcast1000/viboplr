import { describe, it, expect } from "vitest";
import { nextQueueKey, librarySelection, entrySelection, queueTrackSelection, isPlayingLibraryRow, isPlayingSelection, isLibraryTrack, isLocalTrack, trackToQueueTrack } from "../queueEntry";
import { sameSong, likeTargetsRow } from "../hooks/useLikeActions";
import type { Track, QueueTrack } from "../types";

// A library Track carries NO key — that field was removed with the last
// `lib:N` producer. Queue-identity fixtures use makeQueueTrack below.
function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 1, path: "file:///test.mp3", title: "Test",
    artist_id: null, artist_name: null, album_id: null, album_title: null,
    year: null, track_number: null, duration_secs: null, format: null,
    file_size: null, collection_id: null, collection_name: null,
    liked: 0, added_at: null, modified_at: null,
    ...overrides,
  };
}

function makeQueueTrack(overrides: Partial<QueueTrack> = {}): QueueTrack {
  return {
    key: "q:1", path: "file:///test.mp3", title: "Test",
    artist_name: null, album_title: null, duration_secs: null,
    format: null, liked: 0,
    ...overrides,
  };
}

describe("nextQueueKey", () => {
  it("returns keys with q: prefix", () => {
    const key = nextQueueKey();
    expect(key).toMatch(/^q:\d+$/);
  });

  it("returns unique keys on each call", () => {
    const keys = new Set([nextQueueKey(), nextQueueKey(), nextQueueKey()]);
    expect(keys.size).toBe(3);
  });
});

// Ids travel as numbers now — these constructors are the only way a selection
// is built, and there is no key→id decoder anywhere. `librarySelection` is what
// makes "View Details" work from a context menu, where no Track object was ever
// in hand: the case that previously forced the id through a `lib:N` key.
describe("selection constructors", () => {
  it("librarySelection names the row", () => {
    expect(librarySelection(42)).toEqual({ kind: "library", libraryId: 42 });
  });

  it("entrySelection names the queue entry", () => {
    expect(entrySelection("ext:9")).toEqual({ kind: "entry", key: "ext:9" });
  });

  it("queueTrackSelection prefers the entry's cached row", () => {
    expect(queueTrackSelection({ key: "ext:9", libraryId: 42 }))
      .toEqual({ kind: "library", libraryId: 42 });
  });

  it("queueTrackSelection falls back to the entry for an id-less track", () => {
    expect(queueTrackSelection({ key: "ext:9", libraryId: null }))
      .toEqual({ kind: "entry", key: "ext:9" });
    expect(queueTrackSelection({ key: "ext:9" }))
      .toEqual({ kind: "entry", key: "ext:9" });
  });
});

// The library list's now-playing highlight. It used to compare
// `currentTrack.key === track.key`, which only worked because
// trackToQueueTrack copied the row's `lib:N` key onto the queue entry — so the
// queue's key format was load-bearing for a library list two layers away, and
// minting queue keys freshly broke the highlight outright.
describe("isPlayingLibraryRow", () => {
  const row = makeTrack({ id: 42 });

  it("matches when the playing entry cached this row", () => {
    expect(isPlayingLibraryRow(row, { libraryId: 42 })).toBe(true);
  });

  it("does not match a different row", () => {
    expect(isPlayingLibraryRow(row, { libraryId: 7 })).toBe(false);
  });

  it("does not match when nothing is playing", () => {
    expect(isPlayingLibraryRow(row, null)).toBe(false);
    expect(isPlayingLibraryRow(row, undefined)).toBe(false);
  });

  // Two nulls must not read as a match — `==` would have said they do.
  it("never matches an id-less row against an id-less entry", () => {
    const idLess = makeTrack({ id: null });
    expect(isPlayingLibraryRow(idLess, { libraryId: null })).toBe(false);
    expect(isPlayingLibraryRow(idLess, {})).toBe(false);
  });
});

// "Is the detail page showing what's playing?" — compared on whichever axis the
// selection is expressed in, so it holds for a library row and an entry alike.
describe("isPlayingSelection", () => {
  it("matches a library selection by id", () => {
    expect(isPlayingSelection(librarySelection(42), { key: "ext:9", libraryId: 42 })).toBe(true);
    expect(isPlayingSelection(librarySelection(42), { key: "ext:9", libraryId: 7 })).toBe(false);
  });

  it("matches an entry selection by key", () => {
    expect(isPlayingSelection(entrySelection("ext:9"), { key: "ext:9" })).toBe(true);
    expect(isPlayingSelection(entrySelection("ext:9"), { key: "ext:8" })).toBe(false);
  });

  it("is false with no selection or nothing playing", () => {
    expect(isPlayingSelection(null, { key: "ext:9", libraryId: 42 })).toBe(false);
    expect(isPlayingSelection(librarySelection(42), null)).toBe(false);
  });
});

describe("trackToQueueTrack libraryId", () => {
  it("carries the library row id into the queue entry", () => {
    expect(trackToQueueTrack(makeTrack({ id: 42 })).libraryId).toBe(42);
  });

  it("carries null for a track with no library row", () => {
    expect(trackToQueueTrack(makeTrack({ id: null })).libraryId).toBeNull();
  });

  // The pair of properties the split exists for: the key is a per-entry render
  // identity, so it is re-minted on collision; libraryId is provenance, so it
  // is shared by every copy of the same row. Re-keying must not touch it.
  it("survives the re-key that makes a duplicate entry unique", () => {
    const original = trackToQueueTrack(makeTrack({ id: 42 }));
    const copy = { ...original, key: nextQueueKey() };
    expect(copy.key).not.toBe(original.key);
    expect(copy.libraryId).toBe(42);
    expect(copy.key).toMatch(/^q:\d+$/);
  });
});

describe("isLibraryTrack", () => {
  it("returns true for track with numeric id", () => {
    expect(isLibraryTrack(makeTrack({ id: 42 }))).toBe(true);
  });

  it("returns false for track with null id", () => {
    expect(isLibraryTrack(makeTrack({ id: null }))).toBe(false);
  });
});

describe("guard behavior for non-library tracks", () => {
  const libraryTrack = makeTrack({ id: 42 });
  const pluginTrack = makeTrack({ id: null, path: "tidal://12345" });
  const externalTrack = makeTrack({ id: null, path: "external://" });

  describe("like eligibility (requires id != null)", () => {
    it("library track is likeable", () => {
      expect(libraryTrack.id != null).toBe(true);
    });

    it("plugin track is not likeable", () => {
      expect(pluginTrack.id != null).toBe(false);
    });

    it("external track is not likeable", () => {
      expect(externalTrack.id != null).toBe(false);
    });
  });

  describe("delete eligibility (requires id != null and local path)", () => {
    function canDelete(t: Track): boolean {
      return t.id != null && isLocalTrack(t);
    }

    it("library track can be deleted", () => {
      expect(canDelete(libraryTrack)).toBe(true);
    });

    it("plugin track cannot be deleted", () => {
      expect(canDelete(pluginTrack)).toBe(false);
    });

    it("external track cannot be deleted", () => {
      expect(canDelete(externalTrack)).toBe(false);
    });

    it("subsonic track cannot be deleted", () => {
      const subsonicTrack = makeTrack({ id: 99, path: "subsonic://server/123" });
      expect(canDelete(subsonicTrack)).toBe(false);
    });
  });

  describe("locate eligibility (requires id != null)", () => {
    it("library track can be located", () => {
      expect(libraryTrack.id != null).toBe(true);
    });

    it("external track cannot be located", () => {
      expect(externalTrack.id != null).toBe(false);
    });
  });

  // Queue-entry identity is the `key` — minted per entry, never shared. A
  // library Track carries no key at all, so identity questions about rows are
  // id questions and identity questions about queue entries are key questions.
  describe("queue-entry identity is the key, not the id", () => {
    it("two entries for the same row keep distinct identities", () => {
      const a = makeQueueTrack({ libraryId: 42, key: nextQueueKey() });
      const b = makeQueueTrack({ libraryId: 42, key: nextQueueKey() });
      expect(a.key === b.key).toBe(false);
      expect(a.libraryId).toBe(b.libraryId);
    });

    it("two id-less entries are NOT confused", () => {
      const a = makeQueueTrack({ libraryId: null, key: nextQueueKey() });
      const b = makeQueueTrack({ libraryId: null, key: nextQueueKey() });
      expect(a.key === b.key).toBe(false);
    });
  });

  describe("sameSong (like propagation predicate)", () => {
    it("matches when keys are identical", () => {
      const a = makeQueueTrack({ key: "q:42" });
      const b = makeQueueTrack({ key: "q:42" });
      expect(sameSong(a, b)).toBe(true);
    });

    it("matches same song across different keys via title + artist", () => {
      // Same song, but the two copies entered the queue separately and so
      // carry unrelated q:N keys.
      const fromLibrary = makeQueueTrack({ key: "q:42", title: "Joga", artist_name: "Björk" });
      const inQueue = makeQueueTrack({ key: "ext:7", title: "Joga", artist_name: "Björk" });
      expect(sameSong(fromLibrary, inQueue)).toBe(true);
    });

    it("does not match different songs", () => {
      const a = makeQueueTrack({ key: "ext:1", title: "Joga", artist_name: "Björk" });
      const b = makeQueueTrack({ key: "ext:2", title: "Hyperballad", artist_name: "Björk" });
      expect(sameSong(a, b)).toBe(false);
    });

    it("treats null and missing artist as equal", () => {
      const a = makeQueueTrack({ key: "ext:1", title: "Untitled", artist_name: null });
      const b = makeQueueTrack({ key: "ext:2", title: "Untitled", artist_name: null });
      expect(sameSong(a, b)).toBe(true);
    });
  });

  describe("likeTargetsRow (library-list patch predicate)", () => {
    const base = { id: 42, title: "Roygbiv", artist_name: "Boards of Canada" };
    const row = (over: Partial<Track> = {}) => makeTrack({ ...base, ...over });
    const entry = (over: Partial<QueueTrack> = {}): QueueTrack =>
      ({ ...trackToQueueTrack(makeTrack(base)), ...over });

    it("matches the row whose id the entry cached", () => {
      expect(likeTargetsRow(row(), entry())).toBe(true);
      expect(likeTargetsRow(row({ id: 7 }), entry())).toBe(false);
    });

    // The regression this predicate exists for: a re-keyed duplicate and every
    // restored entry carry the library id with an unrelated `q:N` key, so a
    // key comparison found no row and — the id being non-null — never reached
    // the metadata fallback either.
    it("matches by id even when the entry's key names nothing", () => {
      expect(likeTargetsRow(row(), entry({ key: "ext:9" }))).toBe(true);
    });

    it("ignores metadata once an id is cached, so a same-titled row is left alone", () => {
      expect(likeTargetsRow(row({ id: 7 }), entry({ key: "ext:9" }))).toBe(false);
    });

    // A plugin search result (Spotify, yt-dlp) never ingested into a collection
    // has no id at all — it falls back to metadata, which is what lets a like
    // made there light up a local copy of the same song.
    it("falls back to title + artist when the entry has no id", () => {
      expect(likeTargetsRow(row(), entry({ key: "ext:9", libraryId: null }))).toBe(true);
      expect(likeTargetsRow(row({ title: "Dayvan Cowboy" }), entry({ key: "ext:9", libraryId: null }))).toBe(false);
    });

    it("matches diacritic variants on the fallback path", () => {
      const local = row({ title: "Jóga", artist_name: "Björk" });
      const external = entry({ key: "ext:9", libraryId: null, title: "Joga", artist_name: "Bjork" });
      expect(likeTargetsRow(local, external)).toBe(true);
    });
  });
});
