import { describe, it, expect, beforeEach } from "vitest";
import {
  noteNativeFailure,
  consumeResolveStale,
  streamLadderStep,
  clearNativeRetries,
  clearAllNativeRetries,
} from "../playback/playbackRetry";

describe("playbackRetry", () => {
  beforeEach(() => clearAllNativeRetries());

  it("reports a failed source as stale exactly once", () => {
    // One-shot is what bounds the work: the replay consumes the mark, so an
    // unrelated later resolve isn't forced to re-run yt-dlp.
    noteNativeFailure("ext:1");
    expect(consumeResolveStale("ext:1")).toBe(true);
    expect(consumeResolveStale("ext:1")).toBe(false);
  });

  it("holds the ladder at full quality for the first retry", () => {
    // The load-bearing assertion. A refusal is not a property of the rung —
    // refusals are ~1 in 4 and cluster in time — so the retry's job is to get a
    // freshly signed URL, not a smaller one. Descending here would give away a
    // quarter of all plays' resolution for no improvement in success rate.
    expect(streamLadderStep("ext:1")).toBe(0);
    expect(noteNativeFailure("ext:1")).toBe(1);
    expect(streamLadderStep("ext:1")).toBe(0);
  });

  it("descends only for the last native attempt", () => {
    // By the second failure the next attempt is the last one, and its
    // alternative is the browser engine at 360p — so a working 480p wins.
    noteNativeFailure("ext:1");
    expect(noteNativeFailure("ext:1")).toBe(2);
    expect(streamLadderStep("ext:1")).toBe(1);
  });

  it("keeps tracks independent", () => {
    // A failing YouTube video must not step down the quality of the next track,
    // nor force it to re-resolve a source that was fine.
    noteNativeFailure("ext:1");
    expect(streamLadderStep("ext:2")).toBe(0);
    expect(consumeResolveStale("ext:2")).toBe(false);
  });

  it("resets a track completely when it is played afresh", () => {
    noteNativeFailure("ext:1");
    noteNativeFailure("ext:1");
    clearNativeRetries("ext:1");
    expect(streamLadderStep("ext:1")).toBe(0);
    expect(consumeResolveStale("ext:1")).toBe(false);
  });

  it("leaves the ladder position standing when only the stale mark is consumed", () => {
    // The resolve consumes staleness; the rung it is resolving AT must survive
    // that consumption, or the last attempt would silently climb back up.
    noteNativeFailure("ext:1");
    noteNativeFailure("ext:1");
    consumeResolveStale("ext:1");
    expect(streamLadderStep("ext:1")).toBe(1);
  });
});
