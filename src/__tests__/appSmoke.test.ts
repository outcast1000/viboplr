import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs dev script, no type declarations
import { checkDump, startupEntry, startupDelta, compareState, EXPECTED_SCHEMA } from "../../scripts/lib/appSmoke.mjs";
import { PROBE_DUMP_SCHEMA } from "../utils/probeControl";

// These checks decide whether a release is broken, so they are tested here
// rather than only exercised by a run that needs a built .app on macOS.

const healthy = {
  schema: EXPECTED_SCHEMA,
  capturedAt: "2026-08-29T00:00:00.000Z",
  app: { version: "1.0.38", profile: "perf", os: "macos", arch: "aarch64" },
  library: { trackCount: 1200 },
  ui: { view: "home", playing: false, miniMode: false, fullscreen: false, currentTrack: null },
  startup: {
    backendSpanMs: 420.4,
    frontendSpanMs: 210.2,
    backend: [{ label: "db", offset_ms: 0, duration_ms: 300.44 }],
    frontend: [{ label: "restore", offset_ms: 10, duration_ms: 120 }],
  },
};

// These two constants live in different languages' halves of the same contract
// and have already drifted once — the app wrote schema 2 while the checker still
// expected 1, and nothing caught it until a run against a real build.
describe("schema constants", () => {
  it("agrees with the app's PROBE_DUMP_SCHEMA", () => {
    expect(EXPECTED_SCHEMA).toBe(PROBE_DUMP_SCHEMA);
  });
});

describe("checkDump", () => {
  it("passes a healthy dump", () => {
    expect(checkDump(healthy)).toEqual([]);
  });

  it("reports a missing dump without throwing", () => {
    expect(checkDump(null)).toHaveLength(1);
    expect(checkDump(undefined)[0]).toMatch(/not an object/);
  });

  // A schema mismatch makes every later field read meaningless, so it must not
  // also emit a pile of derived complaints.
  it("stops at a schema mismatch instead of cascading", () => {
    const problems = checkDump({ ...healthy, schema: 99 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/schema/);
  });

  it("catches a bundle built from stale sources", () => {
    const problems = checkDump(healthy, { expectedVersion: "1.0.39" });
    expect(problems).toEqual([expect.stringContaining("expected 1.0.39")]);
  });

  it("passes when no version is pinned", () => {
    expect(checkDump(healthy, { expectedVersion: null })).toEqual([]);
  });

  // null means the invoke failed; 0 is a legitimately empty library and must not
  // be reported as a broken database.
  it("distinguishes an empty library from a database that never answered", () => {
    expect(checkDump({ ...healthy, library: { trackCount: 0 } })).toEqual([]);
    expect(checkDump({ ...healthy, library: { trackCount: null } })).toEqual([
      expect.stringContaining("database did not answer"),
    ]);
  });

  it("catches a frontend that never mounted", () => {
    const dump = { ...healthy, ui: { ...healthy.ui, view: "" } };
    expect(checkDump(dump)).toEqual([expect.stringContaining("did not finish mounting")]);
  });

  it("catches a startup path that recorded nothing on either side", () => {
    const dump = { ...healthy, startup: { ...healthy.startup, backend: [], frontend: [] } };
    expect(checkDump(dump)).toHaveLength(2);
  });

  it("reports every independent failure at once", () => {
    const dump = {
      ...healthy,
      app: { ...healthy.app, profile: "default" },
      library: { trackCount: null },
    };
    expect(checkDump(dump)).toHaveLength(2);
  });
});

// This is what stops the probe sampling a state it never reached. Every gap it
// catches was previously a plausible number rather than an error.
describe("compareState", () => {
  const playing = {
    ui: { view: "search", playing: true, miniMode: false, fullscreen: false, currentTrack: "A — B" },
  };

  it("passes when every declared axis matches", () => {
    expect(compareState(playing, { view: "search", playing: true })).toBeNull();
  });

  it("only checks the axes the scenario declared", () => {
    // miniMode/fullscreen are false here but not asked about — not a mismatch.
    expect(compareState(playing, { view: "search" })).toBeNull();
  });

  it("names every axis that is wrong, not just the first", () => {
    const msg = compareState(playing, { view: "nowplaying", miniMode: true });
    expect(msg).toContain("view=");
    expect(msg).toContain("miniMode=");
  });

  // The failure this exists for: an empty perf-profile queue means `play=on`
  // does nothing, and every "playing" scenario silently samples an idle app.
  it("catches playback that never started", () => {
    const idle = { ui: { ...playing.ui, playing: false, currentTrack: null } };
    expect(compareState(idle, { playing: true })).toContain("playing=false");
  });

  // `playing` can be optimistically true while the track failed to load, which
  // looks identical in the flag alone.
  it("catches a playing flag with nothing behind it", () => {
    const empty = { ui: { ...playing.ui, currentTrack: null } };
    expect(compareState(empty, { playing: true })).toContain("queue empty");
  });

  it("reports a dump with no ui state rather than throwing", () => {
    expect(compareState({}, { view: "home" })).toBe("dump carried no ui state");
    expect(compareState(null, { view: "home" })).toBe("dump carried no ui state");
  });
});

describe("startupEntry", () => {
  it("records the library size so entries are comparable", () => {
    expect(startupEntry(healthy, { version: "x" }).tracks).toBe(1200);
  });

  it("keeps the two spans separate and rounds to 0.1ms", () => {
    const entry = startupEntry(healthy, { version: "1.0.38", at: new Date("2026-08-29T12:00:00Z") });
    expect(entry).toMatchObject({
      version: "1.0.38",
      date: "2026-08-29",
      backend_span_ms: 420.4,
      frontend_span_ms: 210.2,
      backend: { db: 300.4 },
    });
    expect(entry).not.toHaveProperty("total_ms");
  });

  it("omits the note key when there is no note", () => {
    expect(startupEntry(healthy, { version: "1.0.38" })).not.toHaveProperty("note");
  });

  // The timer doesn't enforce unique labels; dropping one of two same-named
  // phases would hide exactly the phase that got slow.
  it("keeps the slowest when a phase label repeats", () => {
    const dump = {
      ...healthy,
      startup: {
        ...healthy.startup,
        backend: [
          { label: "scan", offset_ms: 0, duration_ms: 10 },
          { label: "scan", offset_ms: 20, duration_ms: 90 },
        ],
      },
    };
    expect(startupEntry(dump, { version: "x" }).backend).toEqual({ scan: 90 });
  });
});

describe("startupDelta", () => {
  const prev = { tracks: 60, backend_span_ms: 400, frontend_span_ms: 200, backend: { db: 300 }, frontend: {} };
  const next = { tracks: 60, backend_span_ms: 460, frontend_span_ms: 190, backend: { db: 355 }, frontend: {} };

  // Startup work scales with the library. The first two real entries were
  // recorded against 0 and 120 tracks, and their delta compared nothing.
  it("refuses to compare across a library-size change", () => {
    const grown = { ...next, tracks: 120 };
    const r = startupDelta(prev, grown);
    expect(r.spans).toBeNull();
    expect(r.movers).toEqual([]);
    expect(r.incomparable).toContain("60 -> 120");
  });

  it("still compares when the count is unknown on either side", () => {
    // Older entries predate the field; refusing there would hide every delta.
    expect(startupDelta({ ...prev, tracks: undefined }, next).spans).not.toBeNull();
  });

  it("has nothing to compare against on the first entry", () => {
    expect(startupDelta(null, next)).toEqual({ spans: null, movers: [] });
  });

  it("reports span deltas and phases past the threshold, worst first", () => {
    const { spans, movers } = startupDelta(prev, next);
    expect(spans).toEqual({ backend_span_ms: 60, frontend_span_ms: -10 });
    expect(movers).toEqual([{ side: "backend", label: "db", delta: 55 }]);
  });

  it("ignores movement under the threshold", () => {
    const quiet = { ...next, backend: { db: 305 } };
    expect(startupDelta(prev, quiet).movers).toEqual([]);
  });

  it("treats a newly appearing phase as its full cost", () => {
    const added = { ...next, backend: { db: 300, migrate: 40 } };
    expect(startupDelta(prev, added).movers).toContainEqual({
      side: "backend",
      label: "migrate",
      delta: 40,
    });
  });
});
