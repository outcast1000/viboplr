import { describe, it, expect } from "vitest";
import {
  recordPlaySession,
  buildPlaySession,
  sessionKey,
  sessionSubtitle,
  snapshotFor,
  replaysFromSnapshot,
  newSnapshotId,
  snapshotIdsOf,
  droppedSnapshotIds,
  SNAPSHOT_TRACK_CAP,
  bumpPlaySession,
  buildMixtapeSession,
  replayTrack,
  cleanStoredSession,
  type RecentPlaySession,
} from "../utils/recentPlays";
import type { QueueTrack } from "../types";
import type { PlaylistContext } from "../hooks/useQueue";

function track(partial: Partial<QueueTrack> = {}): QueueTrack {
  return {
    key: "ext:1",
    path: "file:///a.mp3",
    title: "Song",
    artist_name: "Artist",
    album_title: "Album",
    duration_secs: 200,
    format: "mp3",
    liked: 0,
    ...partial,
  };
}

function session(partial: Partial<RecentPlaySession> = {}): RecentPlaySession {
  return { source: "album", name: "A", artistName: "X", ts: 1, ...partial };
}

describe("recordPlaySession", () => {
  it("appends a new session", () => {
    const after = recordPlaySession([], session({ name: "A", ts: 1 }));
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe("A");
  });

  it("moves a repeated session to the front (dedup by key)", () => {
    const before = [session({ name: "A", ts: 1 }), session({ name: "B", ts: 2 })];
    const after = recordPlaySession(before, session({ name: "A", ts: 3 }));
    expect(after).toHaveLength(2);
    expect(after.map((s) => s.name)).toEqual(["B", "A"]); // A re-added at the end (newest)
    expect(after[1].ts).toBe(3);
  });

  it("treats different sources with the same name as distinct", () => {
    const before = [session({ source: "album", name: "A", artistName: null })];
    const after = recordPlaySession(before, session({ source: "artist", name: "A", artistName: null }));
    expect(after).toHaveLength(2);
  });

  it("caps at 12, dropping the oldest", () => {
    let acc: RecentPlaySession[] = [];
    for (let i = 0; i < 15; i++) acc = recordPlaySession(acc, session({ name: `n${i}`, ts: i }));
    expect(acc).toHaveLength(12);
    expect(acc[0].name).toBe("n3"); // n0..n2 dropped
    expect(acc[11].name).toBe("n14");
  });
});

describe("sessionKey", () => {
  it("is case-insensitive and folds artist", () => {
    expect(sessionKey({ source: "album", name: "Abbey Road", artistName: "The Beatles" }))
      .toBe(sessionKey({ source: "album", name: "abbey road", artistName: "the beatles" }));
  });
});

describe("buildPlaySession", () => {
  const now = 100;

  it("album context → album session with artist from metadata", () => {
    const ctx: PlaylistContext = { name: "Abbey Road", source: "album", imagePath: "/c.jpg", metadata: { artist: "The Beatles" } };
    const s = buildPlaySession([track()], 0, ctx, now);
    expect(s).toMatchObject({ source: "album", name: "Abbey Road", artistName: "The Beatles", imagePath: "/c.jpg" });
  });

  it("artist context → artist session", () => {
    const ctx: PlaylistContext = { name: "Radiohead", source: "artist", imagePath: "/a.jpg" };
    expect(buildPlaySession([track()], 0, ctx, now)).toMatchObject({ source: "artist", name: "Radiohead" });
  });

  it("radio context → seed title AND artist taken from the seed track (tracks[0])", () => {
    // build_radio_for_track returns the seed first; the seed artist is required
    // to re-resolve the station, so it must be captured (not left null).
    const seed = track({ title: "Karma Police", artist_name: "Radiohead" });
    const ctx: PlaylistContext = { name: "Radio: Karma Police", source: "radio", imagePath: "/r.jpg" };
    const s = buildPlaySession([seed, track()], 0, ctx, now);
    expect(s).toMatchObject({ source: "radio", seedTitle: "Karma Police", seedArtist: "Radiohead" });
  });

  it("radio context falls back to the parsed name when the seed track has no title", () => {
    const ctx: PlaylistContext = { name: "Radio: Roza", source: "radio" };
    const s = buildPlaySession([], 0, ctx, now);
    expect(s).toMatchObject({ source: "radio", seedTitle: "Roza", seedArtist: null });
  });

  it("unknown/plugin context → playlist session (replays its lead track)", () => {
    const lead = track({ title: "First" });
    const ctx: PlaylistContext = { name: "My Mix", source: "playlist" };
    const s = buildPlaySession([lead, track()], 0, ctx, now);
    expect(s).toMatchObject({ source: "playlist", name: "My Mix" });
    expect(s?.track?.title).toBe("First");
  });

  it("no context → track session keyed on the lead track", () => {
    const s = buildPlaySession([track({ title: "Loner", artist_name: "Solo" })], 0, null, now);
    expect(s).toMatchObject({ source: "track", name: "Loner", artistName: "Solo" });
  });

  it("uses startIndex to pick the lead track", () => {
    const s = buildPlaySession([track({ title: "one" }), track({ title: "two" })], 1, null, now);
    expect(s?.name).toBe("two");
  });

  it("empty play with no context → null", () => {
    expect(buildPlaySession([], 0, null, now)).toBeNull();
  });
});

describe("sessionSubtitle", () => {
  it("album shows the artist, falling back to a label", () => {
    expect(sessionSubtitle(session({ source: "album", artistName: "X" }))).toBe("X");
    expect(sessionSubtitle(session({ source: "album", artistName: null }))).toBe("Album");
  });

  it("non-artist sources show a type label", () => {
    expect(sessionSubtitle(session({ source: "radio" }))).toBe("Radio");
    expect(sessionSubtitle(session({ source: "artist" }))).toBe("Artist");
    expect(sessionSubtitle(session({ source: "tag" }))).toBe("Tag");
    expect(sessionSubtitle(session({ source: "playlist" }))).toBe("Playlist");
  });
});

describe("Latest play snapshots", () => {
  const tracks = (n: number) => Array.from({ length: n }, (_, i) => track({ key: `q:${i}`, title: `T${i}`, path: `file:///${i}.mp3` }));

  it("snapshots radio, playlists and selections, never album/artist/tag or a lone track", () => {
    for (const source of ["radio", "playlist", "track"] as const) {
      expect(snapshotFor(tracks(3), 0, source)).not.toBeNull();
    }
    for (const source of ["album", "artist", "tag"] as const) {
      expect(snapshotFor(tracks(3), 0, source)).toBeNull();
    }
    expect(snapshotFor(tracks(1), 0, "playlist")).toBeNull();
  });

  it("keeps a short play whole, with its start position", () => {
    const snap = snapshotFor(tracks(30), 4, "radio")!;
    expect(snap.tracks).toHaveLength(30);
    expect(snap.startIndex).toBe(4);
  });

  it("caps a long play at the 100 tracks from where it started", () => {
    const snap = snapshotFor(tracks(250), 120, "playlist")!;
    expect(snap.tracks).toHaveLength(SNAPSHOT_TRACK_CAP);
    expect(snap.tracks[0].title).toBe("T120");
    expect(snap.tracks[99].title).toBe("T219");
    expect(snap.startIndex).toBe(0);
  });

  it("replays from the snapshot only for sources that took one", () => {
    expect(replaysFromSnapshot({ source: "radio", snapshotId: "a" })).toBe(true);
    expect(replaysFromSnapshot({ source: "radio" })).toBe(false);
    // An album session can't replay a snapshot even if one were named.
    expect(replaysFromSnapshot({ source: "album", snapshotId: "a" })).toBe(false);
  });

  it("mints ids the backend accepts as file names", () => {
    const id = newSnapshotId(1_759_000_000_000, () => 0.5);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(newSnapshotId(1, () => 0)).not.toBe(newSnapshotId(1, () => 0.999));
  });

  it("names the snapshots to delete when a session leaves the ring or is replaced", () => {
    const a = session({ source: "radio", name: "Radio: A", snapshotId: "a" });
    const b = session({ source: "playlist", name: "B", snapshotId: "b" });
    const album = session({ source: "album", name: "C" });
    const prev = [a, b, album];
    expect(snapshotIdsOf(prev)).toEqual(["a", "b"]);
    // Replaying "Radio: A" records a new session (new snapshot) under the same key.
    const next = recordPlaySession(prev, session({ source: "radio", name: "Radio: A", snapshotId: "a2", ts: 2 }));
    expect(droppedSnapshotIds(prev, next)).toEqual(["a"]);
    // Ring eviction: twelve newer plays push both snapshots out.
    let ring = prev;
    for (let i = 0; i < 12; i++) ring = recordPlaySession(ring, session({ source: "album", name: `X${i}`, ts: 10 + i }));
    expect(droppedSnapshotIds(prev, ring)).toEqual(["a", "b"]);
  });
});

describe("replaying a card", () => {
  it("moves it to the front and keeps its snapshot", () => {
    const prev = [
      session({ source: "playlist", name: "Mix", artistName: null, snapshotId: "snap-1", startIndex: 2, ts: 1 }),
      session({ source: "album", name: "B", ts: 2 }),
    ];
    const after = bumpPlaySession(prev, prev[0], 99);
    expect(after.map((s) => s.name)).toEqual(["B", "Mix"]);
    expect(after[1]).toMatchObject({ snapshotId: "snap-1", startIndex: 2, ts: 99 });
    expect(droppedSnapshotIds(prev, after)).toEqual([]);
  });

  it("prefers the live entry over the shelf's older copy", () => {
    const live = session({ source: "playlist", name: "Mix", artistName: null, snapshotId: "new", ts: 5 });
    const shelfCopy = { ...live, snapshotId: "deleted", ts: 1 };
    const after = bumpPlaySession([live], shelfCopy, 9);
    expect(after).toHaveLength(1);
    expect(after[0].snapshotId).toBe("new");
  });

  it("forgets an unreadable snapshot when asked", () => {
    const prev = [session({ source: "radio", name: "Radio: X", artistName: null, snapshotId: "bad", startIndex: 0 })];
    const after = bumpPlaySession(prev, prev[0], 9, { dropSnapshot: true });
    expect(after[0].snapshotId).toBeUndefined();
    expect(after[0].startIndex).toBeUndefined();
    expect(droppedSnapshotIds(prev, after)).toEqual(["bad"]);
  });
});

describe("mixtape cards", () => {
  const lead = track({ path: "mixtape://10+20@/m/Road Trip.mixtape" });

  it("point at the file, store no cover and take no snapshot", () => {
    const s = buildMixtapeSession("/m/Road Trip.mixtape", "Road Trip", lead, 7);
    const { key: _key, ...stored } = lead;
    expect(s).toEqual({ source: "mixtape", name: "Road Trip", mixtapePath: "/m/Road Trip.mixtape", track: stored, ts: 7 });
    expect(snapshotFor([lead, lead, lead], 0, "mixtape")).toBeNull();
    expect(replaysFromSnapshot(s)).toBe(false);
    expect(sessionSubtitle(s)).toBe("Mixtape");
  });

  it("are keyed by file, so two mixtapes with one title stay two cards", () => {
    const a = buildMixtapeSession("/m/a.mixtape", "Road Trip", lead, 1);
    const b = buildMixtapeSession("/m/b.mixtape", "Road Trip", lead, 2);
    expect(sessionKey(a)).not.toBe(sessionKey(b));
    expect(recordPlaySession([a], b)).toHaveLength(2);
    expect(recordPlaySession([a], { ...a, ts: 3 })).toHaveLength(1);
  });
});

// The lead track is a fallback replay, persisted in the store across launches.
// Its queue key named one entry of the session that recorded it; the counter
// restarts every launch, so a stored key comes back as another live entry's —
// and the resolver cache (keyed by it) then played THAT entry's file under
// this card's title. The rowid is reusable too. Neither may be stored.
describe("session lead track identity", () => {
  const lead = track({ key: "q:4", libraryId: 12856, title: "King Park" });

  it("stores neither the queue key nor the library id", () => {
    const sessions = [
      buildPlaySession([lead], 0, null, 1),
      buildPlaySession([lead, track()], 0, { name: "Mix", source: "playlist" }, 1),
      buildPlaySession([lead], 0, { name: "Wildlife", source: "album" }, 1),
      buildMixtapeSession("/m/x.mixtape", "X", lead, 1),
    ];
    for (const s of sessions) {
      expect(s?.track?.title).toBe("King Park");
      expect(s?.track).not.toHaveProperty("key");
      expect(s?.track).not.toHaveProperty("libraryId");
    }
  });

  it("replays as a new entry with a fresh key, even from a card saved with one", () => {
    // A card recorded before keys were stripped still holds `q:4`.
    const legacy = { ...lead } as unknown as Parameters<typeof replayTrack>[0];
    const a = replayTrack(legacy);
    const b = replayTrack(legacy);
    expect(a.key).not.toBe("q:4");
    expect(a.key).not.toBe(b.key);
    expect(a).not.toHaveProperty("libraryId");
    expect(a.title).toBe("King Park");
    expect(a.path).toBe(lead.path);
  });
});

describe("cleanStoredSession", () => {
  it("strips the key and rowid a card saved before stripping existed still holds", () => {
    const legacy = { ...session({ source: "track", name: "King Park" }), track: track({ key: "q:4", libraryId: 12856, file_size: 9_000_000 }) } as unknown as RecentPlaySession;
    const cleaned = cleanStoredSession(legacy);
    expect(cleaned.track).not.toHaveProperty("key");
    expect(cleaned.track).not.toHaveProperty("libraryId");
    // Everything a card shows survives.
    expect(cleaned.track?.file_size).toBe(9_000_000);
    expect(cleaned.track?.title).toBe("Song");
    expect(cleaned.name).toBe("King Park");
  });

  it("returns the same object when there is nothing to strip", () => {
    const clean = buildPlaySession([track()], 0, null, 1)!;
    expect(cleanStoredSession(clean)).toBe(clean);
    const none = session();
    expect(cleanStoredSession(none)).toBe(none);
  });
});
