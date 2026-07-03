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
