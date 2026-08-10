import { describe, it, expect } from "vitest";
import {
  applyBuffer,
  bufferedEndAt,
  bufferedFraction,
  formatReadahead,
  type PlaybackBuffer,
} from "../playback/bufferState";

/** Minimal stand-in for the element's TimeRanges (jsdom won't build one). */
function ranges(...spans: Array<[number, number]>): TimeRanges {
  return {
    length: spans.length,
    start: (i: number) => spans[i][0],
    end: (i: number) => spans[i][1],
  } as TimeRanges;
}

describe("bufferedEndAt", () => {
  it("returns the end of the range covering the play position", () => {
    expect(bufferedEndAt(ranges([0, 45]), 12)).toBe(45);
  });

  it("ignores ranges the position isn't inside", () => {
    // A seek left a stale range behind and started a new one. Reporting the
    // old range's end would draw a buffered edge the element can't play to.
    expect(bufferedEndAt(ranges([0, 20], [120, 160]), 130)).toBe(160);
  });

  it("returns null when a gap separates the position from every range", () => {
    expect(bufferedEndAt(ranges([0, 20], [120, 160]), 60)).toBeNull();
  });

  it("tolerates the position sitting a frame outside its own range", () => {
    // currentTime and the range bounds drift; a hairline overshoot must not
    // read as "nothing is buffered" and blank the indicator mid-playback.
    expect(bufferedEndAt(ranges([10, 45]), 45.1)).toBe(45);
    expect(bufferedEndAt(ranges([10, 45]), 9.9)).toBe(45);
  });

  it("is null when the element has no ranges at all", () => {
    expect(bufferedEndAt(ranges(), 0)).toBeNull();
    expect(bufferedEndAt(null, 0)).toBeNull();
    expect(bufferedEndAt(undefined, 0)).toBeNull();
  });
});

describe("bufferedFraction", () => {
  it("converts an absolute buffered end to a 0..1 fraction", () => {
    expect(bufferedFraction(60, 240)).toBe(0.25);
  });

  it("clamps a cache that reads past the end of the track", () => {
    expect(bufferedFraction(250, 240)).toBe(1);
  });

  it("is null when either side is unknown", () => {
    // Unknown must never collapse to 0: a seek bar told "0% buffered" dims the
    // whole track, which is exactly wrong for a local file that reports nothing.
    expect(bufferedFraction(null, 240)).toBeNull();
    expect(bufferedFraction(60, 0)).toBeNull();
    expect(bufferedFraction(60, Infinity)).toBeNull();
    expect(bufferedFraction(Infinity, 240)).toBeNull();
  });
});

describe("formatReadahead", () => {
  it("keeps a decimal in the range a stall actually lives in", () => {
    // A bare "0s" looks frozen; "0.4s" climbing to "0.9s" shows recovery.
    expect(formatReadahead(0.4)).toBe("0.4s");
    expect(formatReadahead(0)).toBe("0.0s");
    expect(formatReadahead(9.94)).toBe("9.9s");
  });

  it("drops the tenths once they're noise", () => {
    expect(formatReadahead(12.4)).toBe("12s");
    expect(formatReadahead(310.6)).toBe("311s");
  });

  it("is null for anything unshowable, so the chip says the bare word", () => {
    expect(formatReadahead(null)).toBeNull();
    expect(formatReadahead(-1)).toBeNull();
    expect(formatReadahead(Infinity)).toBeNull();
    expect(formatReadahead(NaN)).toBeNull();
  });
});

describe("applyBuffer", () => {
  const base: PlaybackBuffer = { stalled: false, readaheadSecs: null, bufferedToSecs: 30 };

  it("folds a patch into the previous state", () => {
    expect(applyBuffer(base, { stalled: true, readaheadSecs: 0.4 })).toEqual({
      stalled: true,
      readaheadSecs: 0.4,
      bufferedToSecs: 30,
    });
  });

  it("starts from a neutral state when there was none", () => {
    expect(applyBuffer(null, { bufferedToSecs: 12 })).toEqual({
      stalled: false,
      readaheadSecs: null,
      bufferedToSecs: 12,
    });
  });

  it("returns the same object when nothing moved", () => {
    // Identity is the contract, not just equality — the browser engine's
    // `progress` handler fires several times a second, and a fresh object each
    // time would re-render the now-playing bar for no visible change.
    expect(applyBuffer(base, { bufferedToSecs: 30 })).toBe(base);
    expect(applyBuffer(base, {})).toBe(base);
  });

  it("returns a new object when a field actually moved", () => {
    expect(applyBuffer(base, { bufferedToSecs: 31 })).not.toBe(base);
  });
});
