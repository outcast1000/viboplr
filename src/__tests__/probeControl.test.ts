import { describe, expect, it } from "vitest";
import {
  parseProbeCommand,
  isProbeProfile,
  buildProbeDump,
  timingSpanMs,
  PROBE_DUMP_SCHEMA,
} from "../utils/probeControl";

describe("isProbeProfile", () => {
  it("accepts the perf profile and its variants", () => {
    expect(isProbeProfile("perf")).toBe(true);
    expect(isProbeProfile("perf-release")).toBe(true);
  });

  // The whole safety story for this route is that a real user's app ignores it.
  it("rejects every other profile", () => {
    expect(isProbeProfile("default")).toBe(false);
    expect(isProbeProfile("dev-1")).toBe(false);
    expect(isProbeProfile("performance")).toBe(false); // prefix must be `perf-`
    expect(isProbeProfile("")).toBe(false);
    expect(isProbeProfile(null)).toBe(false);
    expect(isProbeProfile(undefined)).toBe(false);
  });
});

describe("parseProbeCommand", () => {
  it("returns null for non-probe links so they fall through to other routes", () => {
    expect(parseProbeCommand("viboplr://quiz")).toBeNull();
    expect(parseProbeCommand("viboplr://install-plugin?url=x")).toBeNull();
    expect(parseProbeCommand("subsonic://host")).toBeNull();
    // Guard against a prefix match swallowing a plugin's own namespace.
    expect(parseProbeCommand("viboplr://probeplugin?x=1")).toBeNull();
  });

  it("parses each action", () => {
    expect(parseProbeCommand("viboplr://probe?view=settings")).toEqual({ view: "settings" });
    expect(parseProbeCommand("viboplr://probe?mini=on")).toEqual({ mini: true });
    expect(parseProbeCommand("viboplr://probe?play=off")).toEqual({ play: false });
    expect(parseProbeCommand("viboplr://probe?window=minimize")).toEqual({ window: "minimize" });
  });

  it("parses several actions from one link", () => {
    expect(parseProbeCommand("viboplr://probe?window=restore&view=nowplaying&play=on")).toEqual({
      window: "restore",
      view: "nowplaying",
      play: true,
    });
  });

  it("accepts a bare probe link and a trailing slash as well-formed no-ops", () => {
    // Must be `{}` and not null — null would forward the link to plugins.
    expect(parseProbeCommand("viboplr://probe")).toEqual({});
    expect(parseProbeCommand("viboplr://probe/")).toEqual({});
    expect(parseProbeCommand("viboplr://probe/?view=home")).toEqual({ view: "home" });
  });

  it("ignores unknown or malformed values rather than acting on a guess", () => {
    // A real View, but not a probe view — viboplr://quiz already opens it.
    expect(parseProbeCommand("viboplr://probe?view=quiz")).toEqual({});
    expect(parseProbeCommand("viboplr://probe?view=nonsense")).toEqual({});
    expect(parseProbeCommand("viboplr://probe?mini=maybe")).toEqual({});
    expect(parseProbeCommand("viboplr://probe?window=close")).toEqual({});
  });

  // perf-probe.mjs appends `_n` to every link because App.tsx's deep-link
  // handler dedupes by exact URL — two scenarios both needing `play=on` would
  // otherwise see the second one dropped and sample the wrong state.
  it("ignores the cache-busting nonce the probe script appends", () => {
    expect(parseProbeCommand("viboplr://probe?view=nowplaying&play=on&_n=4")).toEqual({
      view: "nowplaying",
      play: true,
    });
  });

  it("accepts flag synonyms and is case-insensitive", () => {
    expect(parseProbeCommand("viboplr://probe?mini=1")).toEqual({ mini: true });
    expect(parseProbeCommand("viboplr://probe?mini=TRUE")).toEqual({ mini: true });
    expect(parseProbeCommand("viboplr://probe?play=0")).toEqual({ play: false });
    expect(parseProbeCommand("VIBOPLR://PROBE?view=HOME")).toEqual({ view: "home" });
  });

  it("parses the dump verb", () => {
    expect(parseProbeCommand("viboplr://probe?dump=on")).toEqual({ dump: true });
    // No path parameter exists by design — the destination is fixed backend-side.
    expect(parseProbeCommand("viboplr://probe?dump=on&path=/etc/passwd")).toEqual({ dump: true });
  });

  it("parses the quit verb", () => {
    expect(parseProbeCommand("viboplr://probe?quit=on")).toEqual({ quit: true });
  });

  it("parses an absolute open path, decoded", () => {
    expect(parseProbeCommand("viboplr://probe?open=%2FUsers%2Falex%2Fa%20song.flac")).toEqual({
      open: "/Users/alex/a song.flac",
    });
    expect(parseProbeCommand("viboplr://probe?open=file%3A%2F%2F%2Ftmp%2Fclip.mp4")).toEqual({
      open: "file:///tmp/clip.mp4",
    });
  });

  // The app's cwd is wherever launchd started it, so a relative path would
  // resolve somewhere nobody intended.
  it("ignores a relative or empty open path", () => {
    expect(parseProbeCommand("viboplr://probe?open=song.flac")).toEqual({});
    expect(parseProbeCommand("viboplr://probe?open=../../etc/hosts")).toEqual({});
    expect(parseProbeCommand("viboplr://probe?open=")).toEqual({});
  });

  // A folder is the only practical way to seed a queue, and the resolver takes
  // every media type — one stray video sorting first turned a whole recorded
  // run of "playing audio" scenarios into video-decode measurements.
  it("parses the open media-kind filter", () => {
    expect(parseProbeCommand("viboplr://probe?open=%2Ftmp%2Fm&openKind=audio")).toEqual({
      open: "/tmp/m",
      openKind: "audio",
    });
    expect(parseProbeCommand("viboplr://probe?open=%2Ftmp%2Fm&openKind=VIDEO")).toEqual({
      open: "/tmp/m",
      openKind: "video",
    });
    // An unrecognised kind must not silently become "no filter" on a caller that
    // meant to filter — but it also must not invent one, so it is simply dropped.
    expect(parseProbeCommand("viboplr://probe?open=%2Ftmp%2Fm&openKind=nonsense")).toEqual({
      open: "/tmp/m",
    });
  });

  it("parses the fullscreen verb", () => {
    expect(parseProbeCommand("viboplr://probe?fullscreen=on")).toEqual({ fullscreen: true });
    expect(parseProbeCommand("viboplr://probe?fullscreen=off")).toEqual({ fullscreen: false });
  });

  it("reaches the non-detail views added for navigation", () => {
    for (const v of ["collections", "extensions", "playlists"]) {
      expect(parseProbeCommand(`viboplr://probe?view=${v}`)).toEqual({ view: v });
    }
  });

  // These are detail views that mean nothing without a selected entity, and the
  // view handler clears the selection — so they must not be reachable as views.
  it("rejects the detail views as plain view targets", () => {
    for (const v of ["artists", "albums", "tags"]) {
      expect(parseProbeCommand(`viboplr://probe?view=${v}`)).toEqual({});
    }
  });

  it("parses entity detail navigation", () => {
    expect(parseProbeCommand("viboplr://probe?artist=Bj%C3%B6rk")).toEqual({
      entity: { kind: "artist", name: "Björk" },
    });
    expect(parseProbeCommand("viboplr://probe?album=Homogenic&albumArtist=Bj%C3%B6rk")).toEqual({
      entity: { kind: "album", name: "Homogenic", artistName: "Björk" },
    });
    expect(parseProbeCommand("viboplr://probe?album=Homogenic")).toEqual({
      entity: { kind: "album", name: "Homogenic" },
    });
    expect(parseProbeCommand("viboplr://probe?tag=ambient")).toEqual({
      entity: { kind: "tag", name: "ambient" },
    });
  });

  // One link can only land on one detail page, so the precedence is fixed
  // rather than "whichever the URL happened to list first".
  it("applies a fixed precedence when several entities are given", () => {
    expect(parseProbeCommand("viboplr://probe?tag=a&album=b&artist=c")).toEqual({
      entity: { kind: "artist", name: "c" },
    });
    expect(parseProbeCommand("viboplr://probe?tag=a&album=b")).toEqual({
      entity: { kind: "album", name: "b" },
    });
  });

  it("ignores an empty entity name", () => {
    expect(parseProbeCommand("viboplr://probe?artist=")).toEqual({});
    expect(parseProbeCommand("viboplr://probe?artist=%20%20")).toEqual({});
  });

  it("combines open with the other verbs", () => {
    expect(parseProbeCommand("viboplr://probe?open=%2Ftmp%2Fa.mp4&view=nowplaying&dump=on")).toEqual({
      open: "/tmp/a.mp4",
      view: "nowplaying",
      dump: true,
    });
  });
});

describe("timingSpanMs", () => {
  it("is the furthest point reached, not the sum of the phases", () => {
    // Two overlapping phases: summing would say 90, but only 60ms elapsed.
    const entries = [
      { label: "a", offset_ms: 0, duration_ms: 50 },
      { label: "b", offset_ms: 20, duration_ms: 40 },
    ];
    expect(timingSpanMs(entries)).toBe(60);
  });

  it("is 0 for no entries and ignores non-finite values", () => {
    expect(timingSpanMs([])).toBe(0);
    expect(timingSpanMs([{ label: "x", offset_ms: NaN, duration_ms: 5 }])).toBe(0);
  });
});

describe("buildProbeDump", () => {
  const input = {
    appVersion: "1.0.37",
    profile: "perf",
    os: "macos",
    arch: "aarch64",
    trackCount: 42,
    artistNames: ["Björk", "Boards of Canada"],
    queueLength: 3,
    view: "home",
    playing: false,
    miniMode: false,
    fullscreen: false,
    currentTrack: null,
    backendTimings: [{ label: "db", offset_ms: 0, duration_ms: 120 }],
    frontendTimings: [{ label: "restore", offset_ms: 10, duration_ms: 30 }],
    capturedAt: "2026-08-29T00:00:00.000Z",
  };

  it("carries the facts the smoke test asserts on", () => {
    const dump = buildProbeDump(input);
    expect(dump.schema).toBe(PROBE_DUMP_SCHEMA);
    expect(dump.app).toEqual({ version: "1.0.37", profile: "perf", os: "macos", arch: "aarch64" });
    expect(dump.library.trackCount).toBe(42);
    expect(dump.ui.view).toBe("home");
  });

  // The two timers have no shared zero — the backend's origin is process start,
  // the frontend's is script evaluation, which happens inside the backend span.
  // A combined total would read as authoritative and mean nothing.
  it("reports the two startup spans separately and never a combined total", () => {
    const dump = buildProbeDump(input);
    expect(dump.startup.backendSpanMs).toBe(120);
    expect(dump.startup.frontendSpanMs).toBe(40);
    expect(dump.startup).not.toHaveProperty("totalMs");
  });
});
