// The queue's Back / Forward history is the Latest play list (queue.md "Queue
// History"). These pin the pure half: which card Back / Forward go to, how a
// card records the queue it was left as, and what an as-left snapshot keeps.
import { describe, it, expect } from "vitest";
import {
  asLeftSnapshot, AS_LEFT_LEAD_IN, SNAPSHOT_TRACK_CAP, backTarget, forwardTarget, leftCard,
  buildQueueSession, sessionKey, sessionSubtitle, replaysFromSnapshot, playsByRecency,
  type RecentPlaySession,
} from "../utils/recentPlays";
import type { QueueTrack } from "../types";

function track(n: number): QueueTrack {
  return { key: `q:${n}`, path: `file:///${n}.mp3`, title: `Song ${n}`, artist_name: "A", album_title: null, duration_secs: 100, format: "mp3" };
}

function card(name: string, ts: number, extra: Partial<RecentPlaySession> = {}): RecentPlaySession {
  return { source: "album", name, artistName: "A", ts, ...extra };
}

// Stored oldest first, as recordPlaySession appends: A (oldest) … C (newest).
const PLAYS = [card("A", 1), card("B", 2), card("C", 3)];
const key = (name: string) => sessionKey(card(name, 0));

describe("backTarget / forwardTarget", () => {
  it("steps through the cards by recency, newest first", () => {
    expect(playsByRecency(PLAYS).map((p) => p.name)).toEqual(["C", "B", "A"]);
    expect(backTarget(PLAYS, key("C"))?.name).toBe("B");
    expect(backTarget(PLAYS, key("B"))?.name).toBe("A");
    expect(forwardTarget(PLAYS, key("A"))?.name).toBe("B");
    expect(forwardTarget(PLAYS, key("B"))?.name).toBe("C");
  });

  it("stops at both ends", () => {
    expect(backTarget(PLAYS, key("A"))).toBeNull();
    expect(forwardTarget(PLAYS, key("C"))).toBeNull();
    expect(backTarget([], null)).toBeNull();
  });

  // A queue no card holds (built by hand, emptied by the control API): Back
  // goes to the newest card, and there is nothing ahead of it.
  it("goes back to the newest card from a queue no card holds", () => {
    expect(backTarget(PLAYS, null)?.name).toBe("C");
    expect(forwardTarget(PLAYS, null)).toBeNull();
  });

  // The live queue's card was evicted from the ring meanwhile.
  it("treats a cursor no card matches like no card", () => {
    expect(backTarget(PLAYS, "album::gone::a")?.name).toBe("C");
    expect(forwardTarget(PLAYS, "album::gone::a")).toBeNull();
  });
});

describe("leftCard", () => {
  const left = { snapshotId: "new", startIndex: 4, positionSecs: 73, track: null };

  it("records where the queue was left, keeping its place when stepping", () => {
    const next = leftCard(PLAYS, key("B"), left);
    const b = next.find((p) => p.name === "B")!;
    expect(b).toMatchObject({ snapshotId: "new", startIndex: 4, positionSecs: 73, ts: 2 });
    expect(playsByRecency(next).map((p) => p.name)).toEqual(["C", "B", "A"]);
  });

  it("moves the card up when a new play replaced it", () => {
    const next = leftCard(PLAYS, key("A"), left, 10);
    expect(playsByRecency(next).map((p) => p.name)).toEqual(["A", "C", "B"]);
  });

  // The old snapshot no longer describes where the queue was left, so a card
  // whose as-left write failed forgets it (and the file is deleted with it).
  it("drops the old snapshot when the new one wasn't written", () => {
    const plays = [card("A", 1, { snapshotId: "old" })];
    const next = leftCard(plays, key("A"), { ...left, snapshotId: undefined });
    expect(next[0].snapshotId).toBeUndefined();
  });

  it("keeps the card's lead when the queue had no entry to name", () => {
    const lead = { path: "file:///x.mp3", title: "X", artist_name: "A", album_title: null, duration_secs: 1, format: null };
    const next = leftCard([card("A", 1, { track: lead })], key("A"), left);
    expect(next[0].track).toEqual(lead);
  });

  it("leaves the list alone for a card that is gone", () => {
    expect(leftCard(PLAYS, "album::gone::a", left)).toBe(PLAYS);
  });
});

describe("asLeftSnapshot", () => {
  it("keeps a short queue whole, on the entry it was on", () => {
    const tracks = [track(1), track(2), track(3)];
    expect(asLeftSnapshot(tracks, 2)).toEqual({ tracks, startIndex: 2 });
  });

  it("is null for an empty queue", () => {
    expect(asLeftSnapshot([], -1)).toBeNull();
  });

  it("clamps an index outside the queue", () => {
    expect(asLeftSnapshot([track(1)], -1)?.startIndex).toBe(0);
    expect(asLeftSnapshot([track(1), track(2)], 9)?.startIndex).toBe(1);
  });

  // A long queue keeps the cap, a few entries before the one it was on.
  it("keeps a window around the current entry of a long queue", () => {
    const tracks = Array.from({ length: 500 }, (_, i) => track(i));
    const snap = asLeftSnapshot(tracks, 250)!;
    expect(snap.tracks).toHaveLength(SNAPSHOT_TRACK_CAP);
    expect(snap.tracks[0]).toBe(tracks[250 - AS_LEFT_LEAD_IN]);
    expect(snap.tracks[snap.startIndex]).toBe(tracks[250]);
  });

  it("keeps the last cap's worth when the queue was near its end", () => {
    const tracks = Array.from({ length: 500 }, (_, i) => track(i));
    const snap = asLeftSnapshot(tracks, 495)!;
    expect(snap.tracks).toHaveLength(SNAPSHOT_TRACK_CAP);
    expect(snap.tracks[SNAPSHOT_TRACK_CAP - 1]).toBe(tracks[499]);
    expect(snap.tracks[snap.startIndex]).toBe(tracks[495]);
  });
});

describe("queue cards", () => {
  it("names a hand-built queue and keys it by its own id", () => {
    const at = new Date(2026, 10, 7, 14, 5).getTime();
    const s = buildQueueSession([track(1), track(2)], 1, at, "abc")!;
    expect(s).toMatchObject({ source: "queue", name: "Your queue · 14:05", queueId: "abc", ts: at });
    expect(s.track?.title).toBe("Song 2");
    expect(sessionKey(s)).toBe("queue::abc");
    expect(sessionSubtitle(s)).toBe("Queue");
  });

  it("is null for an empty queue", () => {
    expect(buildQueueSession([], -1, 0, "abc")).toBeNull();
  });

  // Two hand-built queues left in the same minute stay two cards.
  it("doesn't merge two queues with the same name", () => {
    const a = buildQueueSession([track(1)], 0, 0, "a")!;
    const b = buildQueueSession([track(2)], 0, 0, "b")!;
    expect(sessionKey(a)).not.toBe(sessionKey(b));
  });

  // A mixtape card replays its file until its queue was left; then the
  // as-left snapshot is what it holds.
  it("replays a mixtape card from its snapshot once it has one", () => {
    expect(replaysFromSnapshot({ source: "mixtape" })).toBe(false);
    expect(replaysFromSnapshot({ source: "mixtape", snapshotId: "s" })).toBe(true);
  });
});
