import { describe, it, expect } from "vitest";
import { driveProgressMachine, needsStreamResolve, preloadLeadTime, type ProgressInputs } from "../playback/progressMachine";
import type { QueueTrack } from "../types";

function makeTrack(overrides: Partial<QueueTrack> = {}): QueueTrack {
  return {
    key: "lib:1",
    path: "file:///music/a.mp3",
    title: "Song",
    artist_name: "Artist",
    album_title: "Album",
    duration_secs: 200,
    format: "mp3",
    liked: 0,
    ...overrides,
  };
}

function inputs(overrides: Partial<ProgressInputs> = {}): ProgressInputs {
  return {
    position: 0,
    duration: 200,
    crossfadeSecs: 0,
    next: null,
    preloadedKey: null,
    preloadReady: false,
    isPreloading: false,
    isCrossfading: false,
    prefetchRequested: false,
    ...overrides,
  };
}

describe("needsStreamResolve", () => {
  it("is false for local and http next tracks", () => {
    expect(needsStreamResolve(makeTrack())).toBe(false);
    expect(needsStreamResolve(makeTrack({ path: "https://example.com/a.mp3" }))).toBe(false);
    expect(needsStreamResolve(makeTrack({ path: "http://example.com/a.mp3" }))).toBe(false);
  });
  it("is true for path-less and plugin-scheme tracks", () => {
    expect(needsStreamResolve(makeTrack({ path: null }))).toBe(true);
    expect(needsStreamResolve(makeTrack({ path: "youtube://abc" }))).toBe(true);
    expect(needsStreamResolve(makeTrack({ path: "subsonic://1/42" }))).toBe(true);
  });
  it("is false when there is no next track", () => {
    expect(needsStreamResolve(null)).toBe(false);
  });
});

describe("preloadLeadTime", () => {
  it("gives slow-resolving tracks a 45s head start, others 20s", () => {
    expect(preloadLeadTime(makeTrack())).toBe(20);
    expect(preloadLeadTime(makeTrack({ path: "youtube://abc" }))).toBe(45);
  });
});

describe("driveProgressMachine", () => {
  it("does nothing when duration is unknown", () => {
    const a = driveProgressMachine(inputs({ duration: 0, position: 0 }));
    expect(a).toEqual({ requestPrefetch: false, invalidatePreload: false, preloadTrack: null, startCrossfade: false });
  });

  it("does nothing far from the end of the track", () => {
    const a = driveProgressMachine(inputs({ position: 50, next: makeTrack() }));
    expect(a.preloadTrack).toBeNull();
    expect(a.requestPrefetch).toBe(false);
  });

  it("requests auto-continue prefetch at the lead time when the queue is empty", () => {
    const a = driveProgressMachine(inputs({ position: 185, next: null }));
    expect(a.requestPrefetch).toBe(true);
    expect(a.preloadTrack).toBeNull();
  });

  it("does not re-request prefetch once requested", () => {
    const a = driveProgressMachine(inputs({ position: 185, next: null, prefetchRequested: true }));
    expect(a.requestPrefetch).toBe(false);
  });

  it("arms the preload inside the lead window", () => {
    const next = makeTrack({ key: "lib:2" });
    const a = driveProgressMachine(inputs({ position: 185, next }));
    expect(a.preloadTrack).toBe(next);
    expect(a.invalidatePreload).toBe(false);
  });

  it("uses the 45s window for tracks that need stream resolution", () => {
    const next = makeTrack({ key: "ext:9", path: "youtube://abc" });
    expect(driveProgressMachine(inputs({ position: 160, next })).preloadTrack).toBe(next);
    // A local next track at the same position is outside its 20s window.
    const local = makeTrack({ key: "lib:2" });
    expect(driveProgressMachine(inputs({ position: 160, next: local })).preloadTrack).toBeNull();
  });

  it("invalidates a stale preload before arming the new next", () => {
    const next = makeTrack({ key: "lib:3" });
    const a = driveProgressMachine(inputs({ position: 185, next, preloadedKey: "lib:2" }));
    expect(a.invalidatePreload).toBe(true);
    expect(a.preloadTrack).toBe(next);
  });

  it("does not double-arm while a preload is already resolving", () => {
    const next = makeTrack({ key: "lib:2" });
    const a = driveProgressMachine(inputs({ position: 185, next, isPreloading: true }));
    expect(a.preloadTrack).toBeNull();
  });

  it("never starts a crossfade on the same tick that (re)arms a preload", () => {
    const next = makeTrack({ key: "lib:3" });
    const a = driveProgressMachine(inputs({
      position: 198, crossfadeSecs: 5, next, preloadedKey: "lib:2", preloadReady: true,
    }));
    expect(a.preloadTrack).toBe(next);
    expect(a.startCrossfade).toBe(false);
  });

  it("starts the crossfade when armed, ready, inside the fade window", () => {
    const next = makeTrack({ key: "lib:2" });
    const a = driveProgressMachine(inputs({
      position: 197, crossfadeSecs: 5, next, preloadedKey: "lib:2", preloadReady: true,
    }));
    expect(a.startCrossfade).toBe(true);
    expect(a.preloadTrack).toBeNull();
  });

  it("does not crossfade when disabled, unready, or already fading", () => {
    const next = makeTrack({ key: "lib:2" });
    const base = { position: 197, next, preloadedKey: "lib:2", preloadReady: true };
    expect(driveProgressMachine(inputs({ ...base, crossfadeSecs: 0 })).startCrossfade).toBe(false);
    expect(driveProgressMachine(inputs({ ...base, crossfadeSecs: 5, preloadReady: false })).startCrossfade).toBe(false);
    expect(driveProgressMachine(inputs({ ...base, crossfadeSecs: 5, isCrossfading: true })).startCrossfade).toBe(false);
  });

  it("does nothing at or past the end of the track", () => {
    const a = driveProgressMachine(inputs({ position: 200, next: makeTrack() }));
    expect(a).toEqual({ requestPrefetch: false, invalidatePreload: false, preloadTrack: null, startCrossfade: false });
  });
});

describe("playback rate", () => {
  // Every threshold in the machine is in TRACK seconds, but what it is really
  // budgeting is WALL-CLOCK time — how long a preload or a fade needs to finish.
  // Above 1x the track drains faster than the clock, so the windows have to widen
  // in track terms to stay the same length in real ones. Getting this wrong looks
  // like a gap between tracks, not like a rate bug, which is why it's tested.
  const next = makeTrack({ key: "lib:2", path: "file:///b.mp3" });

  it("widens the preload window in track seconds as the rate rises", () => {
    // 20s lead at 1x. At 1.35x the same 20 real seconds is 27 track seconds, so a
    // position that was too early to arm becomes late enough.
    const early = { position: 200 - 25, next, preloadedKey: null };
    expect(driveProgressMachine(inputs({ ...early })).preloadTrack).toBeNull();
    expect(driveProgressMachine(inputs({ ...early, rate: 1.35 })).preloadTrack).toBe(next);
  });

  it("keeps the real-time lead constant across rates", () => {
    // The boundary should sit at leadSecs * rate in track terms, for any rate.
    for (const rate of [1, 1.35, 2.34, 0.74]) {
      const boundary = 20 * rate;
      const inside = driveProgressMachine(inputs({
        position: 200 - (boundary - 0.5), next, preloadedKey: null, rate,
      }));
      const outside = driveProgressMachine(inputs({
        position: 200 - (boundary + 0.5), next, preloadedKey: null, rate,
      }));
      expect(inside.preloadTrack).toBe(next);
      expect(outside.preloadTrack).toBeNull();
    }
  });

  it("widens the slow stream-resolve lead too", () => {
    // 45s at 1x because yt-dlp is slow; unscaled it would be 33 real seconds at
    // 1.35x, quietly eating a quarter of the budget it was given.
    const streamy = makeTrack({ key: "lib:9", path: "ytdlp://abc" });
    const at = { position: 200 - 50, next: streamy, preloadedKey: null };
    expect(driveProgressMachine(inputs({ ...at })).preloadTrack).toBeNull();
    expect(driveProgressMachine(inputs({ ...at, rate: 1.35 })).preloadTrack).toBe(streamy);
  });

  it("widens the crossfade window as well", () => {
    const base = { next, preloadedKey: "lib:2", preloadReady: true, crossfadeSecs: 5 };
    expect(driveProgressMachine(inputs({ ...base, position: 194 })).startCrossfade).toBe(false);
    expect(driveProgressMachine(inputs({ ...base, position: 194, rate: 2 })).startCrossfade).toBe(true);
  });

  it("treats a missing, zero or negative rate as 1x rather than disabling preload", () => {
    // A bad rate must not be able to switch preloading off entirely.
    const at = { position: 200 - 15, next, preloadedKey: null };
    for (const rate of [undefined, 0, -3, NaN]) {
      expect(driveProgressMachine(inputs({ ...at, rate })).preloadTrack).toBe(next);
    }
  });
});
