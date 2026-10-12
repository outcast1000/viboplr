import { describe, it, expect } from "vitest";
import {
  applyActivityEvent,
  currentSession,
  pillView,
  filterLog,
  relativeTime,
  ACTIVITY_LOG_LIMIT,
  PILL_HOLD_MS,
  PILL_LINGER_MS,
  SESSION_GAP_MS,
  type ActivityEntry,
  type ActivityEvent,
} from "../utils/assistantActivity";

function ev(over: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: 1,
    phase: "start",
    atMs: 1_000,
    method: "POST",
    route: "/v1/likes",
    label: "Change a like",
    kind: "write",
    ...over,
  };
}

function entry(over: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: 1,
    startedMs: 1_000,
    label: "Change a like",
    kind: "write",
    method: "POST",
    route: "/v1/likes",
    status: "ok",
    durationMs: 10,
    ...over,
  };
}

describe("applyActivityEvent", () => {
  it("adds a running entry on start and settles the same entry on end", () => {
    let log = applyActivityEvent([], ev({ phase: "start" }));
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("running");
    log = applyActivityEvent(log, ev({ phase: "end", outcome: "ok", durationMs: 40, atMs: 1_040 }));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: "ok", durationMs: 40, startedMs: 1_000 });
  });

  it("creates an entry from an end alone (a read, or a refused call)", () => {
    const log = applyActivityEvent(
      [],
      ev({ id: 7, phase: "end", kind: "read", outcome: "ok", atMs: 5_000, durationMs: 20 }),
    );
    expect(log[0]).toMatchObject({ id: 7, status: "ok", startedMs: 4_980 });
  });

  it("carries what the call touched and what came back", () => {
    let log = applyActivityEvent([], ev({ detail: "3 tracks (at the end)" }));
    expect(log[0].detail).toBe("3 tracks (at the end)");
    log = applyActivityEvent(log, ev({ phase: "end", outcome: "ok", detail: "3 tracks (at the end)", result: "added 2, skipped 1 duplicate" }));
    expect(log[0]).toMatchObject({ detail: "3 tracks (at the end)", result: "added 2, skipped 1 duplicate" });
    // An end that arrives alone (a refused call) keeps its detail too.
    const refused = applyActivityEvent([], ev({ id: 9, phase: "end", outcome: "paused", detail: "Liked track “So What”" }));
    expect(refused[0].detail).toBe("Liked track “So What”");
  });

  it("keeps the error text a failed call returned", () => {
    let log = applyActivityEvent([], ev({}));
    log = applyActivityEvent(log, ev({ phase: "end", outcome: "failed", error: "track not found" }));
    expect(log[0]).toMatchObject({ status: "failed", error: "track not found" });
  });

  it("ignores a duplicate start and caps the log, newest first", () => {
    let log = applyActivityEvent([], ev({ id: 1 }));
    expect(applyActivityEvent(log, ev({ id: 1 }))).toBe(log);
    for (let i = 2; i < ACTIVITY_LOG_LIMIT + 20; i++) log = applyActivityEvent(log, ev({ id: i }));
    expect(log).toHaveLength(ACTIVITY_LOG_LIMIT);
    expect(log[0].id).toBe(ACTIVITY_LOG_LIMIT + 19);
  });
});

describe("pillView", () => {
  const now = 10_000;

  it("is hidden when nothing is happening, and reads never light it", () => {
    expect(pillView([], false, now, 0)).toEqual({ mode: "hidden" });
    const reads = [entry({ kind: "read", status: "running" }), entry({ id: 2, kind: "ui", status: "ok", startedMs: now })];
    expect(pillView(reads, false, now, 0)).toEqual({ mode: "hidden" });
  });

  it("counts the session instead of naming the latest call", () => {
    const log = [
      entry({ id: 3, status: "running", label: "Edit tags", startedMs: now }),
      entry({ id: 2, status: "ok", label: "Add to the queue", startedMs: now - 500, durationMs: 100 }),
      entry({ id: 1, status: "ok", label: "Change a like", startedMs: now - 900, durationMs: 100 }),
    ];
    expect(pillView(log, false, now, 0)).toEqual({ mode: "working", count: 3, outward: false });
  });

  it("holds 'working' briefly after the last call, so a burst doesn't flicker", () => {
    const log = [entry({ startedMs: now - 1_000, durationMs: 100 })];
    expect(pillView(log, false, now, 0).mode).toBe("working");
    expect(pillView(log, false, now - 900 + PILL_HOLD_MS + 1, 0).mode).toBe("done");
  });

  it("starts a new session after a quiet gap", () => {
    const log = [
      entry({ id: 2, status: "running", startedMs: now }),
      entry({ id: 1, startedMs: now - SESSION_GAP_MS - 5_000, durationMs: 100 }),
    ];
    expect(currentSession(log).map((e) => e.id)).toEqual([2]);
    expect(pillView(log, false, now, 0)).toMatchObject({ mode: "working", count: 1 });
  });

  it("marks a session with an outward call as such", () => {
    const log = [entry({ kind: "outward", status: "running", label: "Run a plugin tool" })];
    expect(pillView(log, false, now, 0)).toMatchObject({ mode: "working", outward: true });
  });

  it("lingers after the session with its countdown, then goes away", () => {
    const ended = now - PILL_HOLD_MS - 1_000;
    const fresh = [entry({ startedMs: ended - 100, durationMs: 100 })];
    const done = pillView(fresh, false, now, 0);
    expect(done).toMatchObject({ mode: "done", count: 1 });
    expect(done.mode === "done" && done.left).toBeGreaterThan(0.9);
    const stale = [entry({ startedMs: now - PILL_LINGER_MS - 1_000, durationMs: 100 })];
    expect(pillView(stale, false, now, 0).mode).toBe("hidden");
  });

  it("keeps a failure until it is dismissed", () => {
    const log = [entry({ id: 4, status: "failed", startedMs: 0 })];
    expect(pillView(log, false, now, 0)).toMatchObject({ mode: "failed", count: 1 });
    expect(pillView(log, false, now, 4).mode).toBe("hidden");
    // A newer failure is not covered by an older dismissal.
    const two = [entry({ id: 5, status: "failed", startedMs: 0 }), ...log];
    expect(pillView(two, false, now, 4)).toMatchObject({ mode: "failed", count: 1 });
  });

  it("paused outranks everything and counts what it refused", () => {
    const log = [
      entry({ id: 9, status: "paused", startedMs: 0 }),
      entry({ id: 8, status: "running" }),
    ];
    expect(pillView(log, true, now, 0)).toEqual({ mode: "paused", refused: 1 });
    expect(pillView(log, true, now, 9)).toEqual({ mode: "paused", refused: 0 });
  });

  it("a refused call is not part of a session", () => {
    expect(currentSession([entry({ status: "paused" })])).toEqual([]);
  });
});

describe("filterLog / relativeTime", () => {
  const log = [
    entry({ id: 4, kind: "read" }),
    entry({ id: 3, kind: "outward" }),
    entry({ id: 2, kind: "write", status: "failed" }),
    entry({ id: 1, kind: "ui" }),
  ];

  it("filters by what the user asks about", () => {
    expect(filterLog(log, "all")).toHaveLength(4);
    expect(filterLog(log, "writes").map((e) => e.id)).toEqual([3, 2]);
    expect(filterLog(log, "outward").map((e) => e.id)).toEqual([3]);
    expect(filterLog(log, "failed").map((e) => e.id)).toEqual([2]);
  });

  it("formats ages compactly", () => {
    expect(relativeTime(1_000, 2_000)).toBe("now");
    expect(relativeTime(0, 12_000)).toBe("12s ago");
    expect(relativeTime(0, 4 * 60_000)).toBe("4 min ago");
    expect(relativeTime(0, 2 * 3_600_000)).toBe("2 h ago");
  });
});
