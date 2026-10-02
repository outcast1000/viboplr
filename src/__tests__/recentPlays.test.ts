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
