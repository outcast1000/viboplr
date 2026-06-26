import { describe, it, expect } from "vitest";
import { isPositionOnScreen, clampToNearestMonitor, searchPanelGeometry } from "../hooks/useMiniMode";
import { isCurrentPlayGeneration, decideHandlePlayOutcome, isActiveMediaElement, canDriveTransitionMachine, crossfadeGainPair } from "../hooks/usePlayback";

// --- Extracted pure functions from hooks ---

// From useAutoContinue.ts: weighted strategy picker
type AutoContinueWeights = {
  random: number;
  sameArtist: number;
  sameTag: number;
  mostPlayed: number;
  liked: number;
};

const STRATEGY_KEYS: (keyof AutoContinueWeights)[] = [
  "random", "sameArtist", "sameTag", "mostPlayed", "liked",
];

const STRATEGY_MAP: Record<keyof AutoContinueWeights, string> = {
  random: "random",
  sameArtist: "same_artist",
  sameTag: "same_tag",
  mostPlayed: "most_played",
  liked: "liked",
};

function pickStrategy(weights: AutoContinueWeights, roll: number): string {
  let cumulative = 0;
  for (const key of STRATEGY_KEYS) {
    cumulative += weights[key];
    if (roll < cumulative) return STRATEGY_MAP[key];
  }
  return "random";
}

describe("pickStrategy (weighted random)", () => {
  const weights: AutoContinueWeights = {
    random: 40, sameArtist: 20, sameTag: 20, mostPlayed: 10, liked: 10,
  };

  it("picks random for roll 0-39", () => {
    expect(pickStrategy(weights, 0)).toBe("random");
    expect(pickStrategy(weights, 39)).toBe("random");
  });

  it("picks same_artist for roll 40-59", () => {
    expect(pickStrategy(weights, 40)).toBe("same_artist");
    expect(pickStrategy(weights, 59)).toBe("same_artist");
  });

  it("picks same_tag for roll 60-79", () => {
    expect(pickStrategy(weights, 60)).toBe("same_tag");
    expect(pickStrategy(weights, 79)).toBe("same_tag");
  });

  it("picks most_played for roll 80-89", () => {
    expect(pickStrategy(weights, 80)).toBe("most_played");
    expect(pickStrategy(weights, 89)).toBe("most_played");
  });

  it("picks liked for roll 90-99", () => {
    expect(pickStrategy(weights, 90)).toBe("liked");
    expect(pickStrategy(weights, 99)).toBe("liked");
  });

  it("falls back to random for out-of-range roll", () => {
    expect(pickStrategy(weights, 100)).toBe("random");
  });

  it("handles all-zero weights by falling back to random", () => {
    const zero = { random: 0, sameArtist: 0, sameTag: 0, mostPlayed: 0, liked: 0 };
    expect(pickStrategy(zero, 0)).toBe("random");
  });

  it("handles single-strategy weight", () => {
    const single = { random: 0, sameArtist: 100, sameTag: 0, mostPlayed: 0, liked: 0 };
    expect(pickStrategy(single, 50)).toBe("same_artist");
  });
});

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
    expect(g.height).toBe(260);
    expect(g.newY).toBe(100); // position unchanged when growing down
  });

  it("grows up (shifting Y) when there is no room below", () => {
    // Window near the bottom: 1080 - (1040 + 52) = -12 room below → grow up.
    const g = searchPanelGeometry({ logicalY: 1040, restingHeight: 52, monitor });
    expect(g.direction).toBe("up");
    expect(g.height).toBe(260);
    // newY = logicalY - (height - restingHeight) = 1040 - (260 - 52) = 832
    expect(g.newY).toBe(832);
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
