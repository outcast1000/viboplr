import { describe, it, expect } from "vitest";
import { isPositionOnScreen, clampToNearestMonitor, fitToMonitor, isRestorableFullGeom, searchPanelGeometry } from "../hooks/useMiniMode";
import { isCurrentPlayGeneration, decideHandlePlayOutcome, isActiveMediaElement, canDriveTransitionMachine, crossfadeGainPair } from "../hooks/usePlayback";
import { isWaveformComputable, isWaveformShowable } from "../hooks/useWaveform";
import { isWaveformSizeAllowed, WAVEFORM_MAX_FILE_SIZE } from "../waveform/browserProvider";

// --- Extracted pure functions from hooks ---

const singleMonitor = [{ x: 0, y: 0, w: 1920, h: 1080 }];
const dualMonitors = [
  { x: 0, y: 0, w: 1920, h: 1080 },
  { x: 1920, y: 0, w: 2560, h: 1440 },
];

describe("isPositionOnScreen", () => {
  it("returns true when point is within a monitor", () => {
    expect(isPositionOnScreen(100, 100, singleMonitor)).toBe(true);
  });

  it("returns false when point is outside all monitors", () => {
    expect(isPositionOnScreen(3000, 500, singleMonitor)).toBe(false);
  });

  it("returns true for top-left edge (inclusive)", () => {
    expect(isPositionOnScreen(0, 0, singleMonitor)).toBe(true);
  });

  it("returns false for right/bottom edge (exclusive)", () => {
    expect(isPositionOnScreen(1920, 1080, singleMonitor)).toBe(false);
  });

  it("returns true for point on second monitor", () => {
    expect(isPositionOnScreen(2000, 500, dualMonitors)).toBe(true);
  });

  it("returns true for negative coordinates on a monitor", () => {
    const leftMonitor = [{ x: -1920, y: 0, w: 1920, h: 1080 }];
    expect(isPositionOnScreen(-500, 500, leftMonitor)).toBe(true);
  });

  it("returns true when monitors array is empty (graceful fallback)", () => {
    expect(isPositionOnScreen(9999, 9999, [])).toBe(true);
  });
});

describe("fitToMonitor", () => {
  const laptop = [{ x: 0, y: 25, w: 1512, h: 920 }];

  it("leaves a window that already fits untouched", () => {
    const g = { x: 100, y: 100, w: 800, h: 600 };
    expect(fitToMonitor(g, laptop)).toEqual(g);
  });

  it("shrinks a window sized for a larger display and pulls it fully on-screen", () => {
    // What macOS leaves behind after unplugging a 2560x1440 external display:
    // evacuated onto the laptop, old size kept.
    expect(fitToMonitor({ x: 200, y: 60, w: 2400, h: 1300 }, laptop))
      .toEqual({ x: 0, y: 25, w: 1512, h: 920 });
  });

  it("moves a window that overhangs the right/bottom edges back inside", () => {
    expect(fitToMonitor({ x: 1200, y: 800, w: 800, h: 600 }, laptop))
      .toEqual({ x: 712, y: 345, w: 800, h: 600 });
  });

  it("fits onto the monitor holding the window's centre", () => {
    const g = fitToMonitor({ x: 1800, y: 100, w: 3000, h: 2000 }, dualMonitors);
    expect(g).toEqual({ x: 1920, y: 0, w: 2560, h: 1440 });
  });

  it("falls back to the monitor it overlaps most when the centre is off-screen", () => {
    const g = fitToMonitor({ x: -700, y: 100, w: 1000, h: 500 }, dualMonitors);
    expect(g).toEqual({ x: 0, y: 100, w: 1000, h: 500 });
  });

  it("returns the geometry unchanged with no monitors", () => {
    const g = { x: 5, y: 5, w: 5000, h: 5000 };
    expect(fitToMonitor(g, [])).toEqual(g);
  });

  it("grows a sliver saved from a minimized window back to the minimum size", () => {
    // The 144×19 a minimized Windows window left in a profile's store.
    expect(fitToMonitor({ x: 1208, y: 791, w: 144, h: 19 }, laptop))
      .toEqual({ x: 1208, y: 545, w: 300, h: 400 });
  });
});

describe("isRestorableFullGeom", () => {
  it("rejects a minimized window's frame and accepts the minimum size", () => {
    expect(isRestorableFullGeom({ w: 144, h: 19 })).toBe(false);
    expect(isRestorableFullGeom({ w: 300, h: 399 })).toBe(false);
    expect(isRestorableFullGeom({ w: 300, h: 400 })).toBe(true);
  });
});

describe("clampToNearestMonitor", () => {
  it("returns unchanged position when already on-screen", () => {
    expect(clampToNearestMonitor(100, 100, 500, 40, singleMonitor)).toEqual({ x: 100, y: 100 });
  });

  it("clamps position off-screen to the right", () => {
    const result = clampToNearestMonitor(2000, 500, 500, 40, singleMonitor);
    expect(result.x).toBe(1420); // 1920 - 500
    expect(result.y).toBe(500);
  });

  it("clamps position off-screen above", () => {
    const result = clampToNearestMonitor(100, -200, 500, 40, singleMonitor);
    expect(result.x).toBe(100);
    expect(result.y).toBe(0);
  });

  it("snaps to nearest monitor in dual setup", () => {
    // Point closer to second monitor
    const result = clampToNearestMonitor(5000, 500, 500, 40, dualMonitors);
    expect(result.x).toBe(3980); // 1920 + 2560 - 500
    expect(result.y).toBe(500);
  });

  it("returns original coordinates when monitors is empty", () => {
    expect(clampToNearestMonitor(9999, 9999, 500, 40, [])).toEqual({ x: 9999, y: 9999 });
  });
});

describe("searchPanelGeometry", () => {
  const monitor = { x: 0, y: 0, w: 1920, h: 1080 };

  it("grows down when there is room below", () => {
    const g = searchPanelGeometry({ logicalY: 100, restingHeight: 52, monitor });
    expect(g.direction).toBe("down");
    expect(g.height).toBe(460);
    expect(g.newY).toBe(100); // position unchanged when growing down
  });

  it("grows up (shifting Y) when there is no room below", () => {
    // Window near the bottom: 1080 - (1040 + 52) = -12 room below → grow up.
    const g = searchPanelGeometry({ logicalY: 1040, restingHeight: 52, monitor });
    expect(g.direction).toBe("up");
    expect(g.height).toBe(460);
    // newY = logicalY - (height - restingHeight) = 1040 - (460 - 52) = 632
    expect(g.newY).toBe(632);
  });

  it("treats a null monitor as unlimited space below (grows down)", () => {
    const g = searchPanelGeometry({ logicalY: 1040, restingHeight: 52, monitor: null });
    expect(g.direction).toBe("down");
    expect(g.newY).toBe(1040);
  });
});

describe("isCurrentPlayGeneration (rapid track-switch abort guard)", () => {
  it("treats a request as current when no newer one started", () => {
    expect(isCurrentPlayGeneration(1, 1)).toBe(true);
  });

  it("treats a superseded request as stale", () => {
    // handlePlay captured generation 1, but a later click bumped the ref to 2.
    expect(isCurrentPlayGeneration(1, 2)).toBe(false);
  });

  it("discards the AbortError from every track skipped past", () => {
    // Simulate pressing Next three times in quick succession: each handlePlay
    // bumps the ref, so only the final request's outcome should be honoured.
    let ref = 0;
    const gen1 = ++ref; // first click
    const gen2 = ++ref; // second click (aborts the first)
    const gen3 = ++ref; // third click (aborts the second)
    // The first two reject with AbortError and must be ignored...
    expect(isCurrentPlayGeneration(gen1, ref)).toBe(false);
    expect(isCurrentPlayGeneration(gen2, ref)).toBe(false);
    // ...only the last request is allowed to surface an error.
    expect(isCurrentPlayGeneration(gen3, ref)).toBe(true);
  });
});

describe("decideHandlePlayOutcome (empty-src / supersession recovery)", () => {
  it("plays when this request is still current and a src resolved", () => {
    expect(decideHandlePlayOutcome(true, true, false)).toBe("play");
  });

  it("bails silently when a NEWER play superseded this one (it owns currentTrack)", () => {
    // Empty src or not — a newer handlePlay will set currentTrack, so we must not
    // touch state here.
    expect(decideHandlePlayOutcome(false, false, false)).toBe("bail");
    expect(decideHandlePlayOutcome(false, true, false)).toBe("bail");
  });

  it("retries the resolve when src is empty but THIS play is still current", () => {
    // The bug: resolveTrackSrc returned the empty-src sentinel because a concurrent
    // preload/prefetch bumped the *resolve* generation — but no newer *play*
    // superseded us. Silently bailing here freezes playback on the old track with
    // the queue already advanced. Recover by re-resolving once.
    expect(decideHandlePlayOutcome(true, false, false)).toBe("retry");
  });

  it("fails loudly when src is still empty after the retry and we're still current", () => {
    // A genuine anomaly: surface it (catch path → error modal) instead of leaving
    // playback paused with a stale now-playing bar.
    expect(decideHandlePlayOutcome(true, false, true)).toBe("fail");
  });

  it("still bails if a newer play arrived during the retry", () => {
    expect(decideHandlePlayOutcome(false, false, true)).toBe("bail");
  });
});

describe("isActiveMediaElement (spurious-error guard during track swap)", () => {
  it("treats the active audio slot's error as real", () => {
    expect(isActiveMediaElement("A", "A", false)).toBe(true);
    expect(isActiveMediaElement("B", "B", false)).toBe(true);
  });

  it("ignores errors from the INACTIVE audio slot (failed preload / torn-down outgoing)", () => {
    // The bug: clicking Next tears down the outgoing element and the inactive slot
    // may hold a preloaded src; either firing an error gets misattributed to the
    // now-playing track, showing "Playback failed" while the active slot plays fine.
    expect(isActiveMediaElement("B", "A", false)).toBe(false);
    expect(isActiveMediaElement("A", "B", false)).toBe(false);
  });

  it("treats the video element's error as real only when a video track is current", () => {
    expect(isActiveMediaElement("video", "A", true)).toBe(true);
    expect(isActiveMediaElement("video", "A", false)).toBe(false);
  });

  it("ignores audio-element errors while a video track is the active surface", () => {
    // For a video track the active media element is the <video>; a stale audio
    // element error must not be surfaced.
    expect(isActiveMediaElement("A", "A", true)).toBe(false);
    expect(isActiveMediaElement("B", "B", true)).toBe(false);
  });
});

describe("canDriveTransitionMachine (preload→crossfade gate)", () => {
  it("runs only on the active element when no play is mid-transition", () => {
    expect(canDriveTransitionMachine(true, false)).toBe(true);
  });

  it("blocks while an explicit play is mid-transition (the low-volume / orphan window)", () => {
    // The bug: during handlePlay's resolve await, a not-fully-stopped outgoing
    // element keeps firing timeupdate while it's still the active slot. Letting it
    // start a crossfade hands a fade to the track being replaced — the incoming
    // explicit play then installs slot A under a live ramp → starts at low volume.
    expect(canDriveTransitionMachine(true, true)).toBe(false);
  });

  it("never runs for a non-active element regardless of transition state", () => {
    expect(canDriveTransitionMachine(false, false)).toBe(false);
    expect(canDriveTransitionMachine(false, true)).toBe(false);
  });
});

describe("crossfadeGainPair (captured-once fade target)", () => {
  it("maps the just-activated slot to its incoming gain node", () => {
    const a = { id: "A" };
    const b = { id: "B" };
    expect(crossfadeGainPair("A", a, b)).toEqual({ incoming: a, outgoing: b });
    expect(crossfadeGainPair("B", a, b)).toEqual({ incoming: b, outgoing: a });
  });

  it("returns a stable pair the interval can reuse even if the active slot later flips", () => {
    // The interval must keep ramping THIS pair; re-deriving from a live activeSlot
    // each tick is what let a mid-fade slot swap pump the incoming gain to ~0.
    const a = { id: "A" };
    const b = { id: "B" };
    const captured = crossfadeGainPair("B", a, b);
    // A later flip to "A" must not change what was captured for this fade.
    expect(captured.incoming).toBe(b);
    expect(captured.outgoing).toBe(a);
  });
});

describe("isWaveformComputable (waveform compute gate)", () => {
  it("accepts a local audio file", () => {
    expect(isWaveformComputable({ path: "file:///music/song.flac", title: "Song", isVideo: false })).toBe(true);
  });

  it("rejects video regardless of scheme", () => {
    // Decoding a whole container to PCM costs orders of magnitude more than an
    // audio file of the same duration.
    expect(isWaveformComputable({ path: "file:///music/clip.mp4", title: "Clip", isVideo: true })).toBe(false);
  });

  it("rejects remote schemes that the webview fetch can never read", () => {
    expect(isWaveformComputable({ path: "subsonic://col-1/42", title: "Song", isVideo: false })).toBe(false);
    expect(isWaveformComputable({ path: "https://example.com/song.mp3", title: "Song", isVideo: false })).toBe(false);
    expect(isWaveformComputable({ path: "ytdlp://abc123", title: "Song", isVideo: false })).toBe(false);
  });

  it("rejects tracks missing a path or title", () => {
    expect(isWaveformComputable({ path: null, title: "Song", isVideo: false })).toBe(false);
    expect(isWaveformComputable({ path: "file:///music/song.flac", title: null, isVideo: false })).toBe(false);
  });
});

describe("isWaveformShowable (waveform display gate)", () => {
  it("accepts anything computable, with or without a duration", () => {
    expect(isWaveformShowable({ path: "file:///music/song.flac", title: "Song", isVideo: false })).toBe(true);
  });

  it("accepts a stream once its length is known — a shared waveform can fit it", () => {
    expect(isWaveformShowable({ path: "subsonic://col-1/42", title: "Song", isVideo: false, durationSecs: 241 })).toBe(true);
    expect(isWaveformShowable({ path: "ytdlp://abc123", title: "Song", isVideo: false, durationSecs: 180 })).toBe(true);
  });

  it("accepts a metadata-only entry a stream resolver plays — no path needed", () => {
    expect(isWaveformShowable({ path: null, title: "Song", isVideo: false, durationSecs: 241 })).toBe(true);
  });

  it("rejects a stream with no length to match on", () => {
    expect(isWaveformShowable({ path: "subsonic://col-1/42", title: "Song", isVideo: false })).toBe(false);
    expect(isWaveformShowable({ path: "subsonic://col-1/42", title: "Song", isVideo: false, durationSecs: 0 })).toBe(false);
  });

  it("still rejects video and untitled tracks", () => {
    expect(isWaveformShowable({ path: "ytdlp://abc123", title: "Clip", isVideo: true, durationSecs: 180 })).toBe(false);
    expect(isWaveformShowable({ path: "ytdlp://abc123", title: null, isVideo: false, durationSecs: 180 })).toBe(false);
  });
});

describe("isWaveformSizeAllowed (size gate)", () => {
  it("allows files at or under the limit", () => {
    expect(isWaveformSizeAllowed(1024)).toBe(true);
    expect(isWaveformSizeAllowed(WAVEFORM_MAX_FILE_SIZE)).toBe(true);
  });

  it("rejects files over the limit", () => {
    expect(isWaveformSizeAllowed(WAVEFORM_MAX_FILE_SIZE + 1)).toBe(false);
    expect(isWaveformSizeAllowed(700 * 1024 * 1024)).toBe(false);
  });

  it("rejects an unknown size rather than assuming it is small", () => {
    // A failed stat must not open the door to decoding an arbitrarily large file.
    expect(isWaveformSizeAllowed(null)).toBe(false);
  });

  it("allows a zero-byte file (the decode will fail harmlessly, not OOM)", () => {
    expect(isWaveformSizeAllowed(0)).toBe(true);
  });
});
