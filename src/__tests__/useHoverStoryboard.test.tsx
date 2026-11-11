// Home cards preview a video by flipping through its storyboard on hover. What
// matters is invisible from outside: a cursor sweeping across a shelf must cost
// nothing (no cache read, no ffmpeg pass), leaving before a pass lands must
// withdraw from it, and a board once loaded must not be asked for again.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import type { Storyboard } from "../utils/storyboard";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
// Captures the progress listener so a test can stream frames as a pass would.
const listeners = new Map<string, (ev: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (ev: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return Promise.resolve(() => { listeners.delete(name); });
  },
}));

import {
  useHoverStoryboard,
  hoverPreviewTrack,
  hoverPreviewTiles,
  hoverPreviewPosition,
  partialPreviewTiles,
  nextPreviewTile,
  shownPreviewTile,
  HOVER_PREVIEW_DWELL_MS,
} from "../hooks/useHoverStoryboard";
import { HOVER_FRAME_INTERVAL_MS } from "../videoFrameQueue";

const VIDEO = { path: "file:///music/clip.mp4", format: "mp4", duration_secs: 600 };

const BOARD: Storyboard = {
  sheets: ["/cache/clip.jpg"],
  cols: 6, rows: 6, count: 36, tileW: 400, tileH: 225, startSecs: 0, intervalSecs: 16,
};

function calls(command: string) {
  return invoke.mock.calls.filter(c => c[0] === command);
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("hoverPreviewTrack", () => {
  it("takes video rows only", () => {
    expect(hoverPreviewTrack(VIDEO)).toEqual(VIDEO);
    expect(hoverPreviewTrack({ path: "file:///music/song.flac", format: "flac" })).toBeNull();
    expect(hoverPreviewTrack({ path: null, format: "mp4" })).toBeNull();
    expect(hoverPreviewTrack(undefined)).toBeNull();
  });

  it("falls back to the path's extension when the row names no format", () => {
    expect(hoverPreviewTrack({ path: "file:///v/clip.mkv" })?.format).toBeNull();
    expect(hoverPreviewTrack({ path: "file:///v/clip.mkv" })).not.toBeNull();
  });
});

describe("hoverPreviewTiles", () => {
  it("plays every tile, in order", () => {
    const tiles = hoverPreviewTiles(BOARD);
    expect(tiles).toHaveLength(BOARD.count);
    expect(tiles[0]).toBe(0);
    expect(tiles[tiles.length - 1]).toBe(BOARD.count - 1);
  });

  it("never addresses padding slots past the frame count", () => {
    // A 6x6 grid holding 20 frames: the other 16 slots are black padding.
    expect(hoverPreviewTiles({ ...BOARD, count: 20 })).toHaveLength(20);
  });

  it("keeps the only tile of a one-tile board", () => {
    expect(hoverPreviewTiles({ ...BOARD, count: 1 })).toEqual([0]);
  });
});

describe("hoverPreviewPosition", () => {
  it("puts each tile at the middle of its slice, against the track's length", () => {
    // BOARD: 16s slices, so tile 0 shows 0:08 and tile 10 shows 2:48 of a 10:00 video.
    expect(hoverPreviewPosition(BOARD, 0, 600)).toEqual({ secs: 8, totalSecs: 600, fraction: 8 / 600 });
    expect(hoverPreviewPosition(BOARD, 10, 600).secs).toBe(168);
  });

  it("cuts the last slice short at the video's end, as the backend does", () => {
    // 36 × 16s = 576s of slices over a 570s video: the last slice is 560–570.
    const last = hoverPreviewPosition(BOARD, 35, 570);
    expect(last.secs).toBe(565);
    expect(last.fraction).toBeCloseTo(565 / 570);
  });

  it("falls back to the board's span when the track's length is unknown", () => {
    expect(hoverPreviewPosition(BOARD, 0, null).totalSecs).toBe(36 * 16);
    expect(hoverPreviewPosition(BOARD, 0, 0).totalSecs).toBe(36 * 16);
  });

  it("never names a moment past the end, nor draws the bar past it", () => {
    // A stored length shorter than the board says — a duration that's wrong.
    const p = hoverPreviewPosition(BOARD, 35, 100);
    expect(p.secs).toBe(100);
    expect(p.fraction).toBe(1);
  });
});

describe("nextPreviewTile", () => {
  it("steps to the next tile and wraps to the start", () => {
    expect(nextPreviewTile([0, 1, 2], 0)).toBe(1);
    expect(nextPreviewTile([0, 1, 2], 2)).toBe(0);
    expect(nextPreviewTile([0, 1, 2], null)).toBe(1); // null shows the first
  });

  it("carries on smoothly while a pass adds frames", () => {
    // On tile 2 of [0,1,2]; frame 3 lands — the next tick shows 3, not a jump.
    expect(nextPreviewTile([0, 1, 2, 3], 2)).toBe(3);
  });

  it("keeps its place when the partial loop becomes the finished sheet", () => {
    // A resumed pass cycled [18..35] and was on 28; the full sheet takes over.
    const full = Array.from({ length: 36 }, (_, i) => i);
    expect(shownPreviewTile(full, 28)).toBe(28);
    expect(nextPreviewTile(full, 28)).toBe(29);
  });

  it("has nothing to show for an empty list", () => {
    expect(shownPreviewTile([], 3)).toBeNull();
    expect(nextPreviewTile([], null)).toBeNull();
  });
});

describe("partialPreviewTiles", () => {
  it("addresses the frames made so far, from where the pass started", () => {
    expect(partialPreviewTiles({ frames: ["a", "b"], startIndex: 0, count: 36 })).toEqual([0, 1]);
    // A resumed pass: its frames start mid-video and keep their real tiles.
    expect(partialPreviewTiles({ frames: ["a", "b"], startIndex: 18, count: 36 })).toEqual([18, 19]);
  });

  it("never runs past the sheet's frame count", () => {
    expect(partialPreviewTiles({ frames: ["a", "b", "c"], startIndex: 35, count: 36 })).toEqual([35]);
  });
});

describe("useHoverStoryboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("asks for nothing while the cursor only passes over the card", async () => {
    invoke.mockResolvedValue(BOARD);
    const { result } = renderHook(() => useHoverStoryboard(VIDEO, { generate: true }));
    act(() => result.current.hoverProps.onMouseEnter());
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS - 50); });
    act(() => result.current.hoverProps.onMouseLeave());
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS); });
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.tile).toBeNull();
  });

  it("does nothing at all for a card that isn't a video", async () => {
    const { result } = renderHook(() => useHoverStoryboard(null, { generate: true }));
    act(() => result.current.hoverProps.onMouseEnter());
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS * 2); });
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it("cycles the cached board after a dwell, and goes back to the art on leave", async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "get_storyboard" ? BOARD : undefined));
    const { result } = renderHook(() => useHoverStoryboard(VIDEO, { generate: true }));
    act(() => result.current.hoverProps.onMouseEnter());
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS); });
    await flush();
    expect(calls("get_storyboard")).toHaveLength(1);
    const tiles = hoverPreviewTiles(BOARD);
    expect(result.current.tile).toBe(tiles[0]);
    expect(result.current.board?.sheets[0]).toBe("asset:///cache/clip.jpg");

    expect(result.current.position).toEqual(hoverPreviewPosition(BOARD, tiles[0], VIDEO.duration_secs));

    act(() => { vi.advanceTimersByTime(HOVER_FRAME_INTERVAL_MS); });
    expect(result.current.tile).toBe(tiles[1]);
    expect(result.current.position?.secs).toBe(24);

    act(() => result.current.hoverProps.onMouseLeave());
    expect(result.current.tile).toBeNull();
    expect(result.current.position).toBeNull();
  });

  it("re-hovering a loaded card cycles at once, without asking again", async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "get_storyboard" ? BOARD : undefined));
    const { result } = renderHook(() => useHoverStoryboard(VIDEO, { generate: true }));
    act(() => result.current.hoverProps.onMouseEnter());
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS); });
    await flush();
    act(() => result.current.hoverProps.onMouseLeave());

    act(() => result.current.hoverProps.onMouseEnter());
    expect(result.current.tile).toBe(hoverPreviewTiles(BOARD)[0]);
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS); });
    await flush();
    expect(calls("get_storyboard")).toHaveLength(1);
  });

  it("generates on a miss, shows it is loading, and withdraws when the cursor leaves", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_storyboard") return Promise.resolve(null);
      if (cmd === "extract_storyboard") return new Promise(() => {}); // runs forever
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useHoverStoryboard(VIDEO, { generate: true }));
    act(() => result.current.hoverProps.onMouseEnter());
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS); });
    await flush();
    expect(calls("extract_storyboard")).toHaveLength(1);
    expect(result.current.loading).toBe(true);

    act(() => result.current.hoverProps.onMouseLeave());
    await flush();
    expect(calls("cancel_storyboard")).toHaveLength(1);
    expect(result.current.loading).toBe(false);
  });

  it("plays the frames a slow pass has made so far, and reports how far it is", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_storyboard") return Promise.resolve(null);
      if (cmd === "extract_storyboard") return new Promise(() => {}); // a slow AV1 pass
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useHoverStoryboard(VIDEO, { generate: true }));
    act(() => result.current.hoverProps.onMouseEnter());
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS); });
    await flush();
    expect(result.current.loading).toBe(true);
    expect(result.current.tile).toBeNull(); // nothing extracted yet

    // A resumed pass that has now made tiles 18 and 19 of 36.
    act(() => listeners.get("storyboard-partial")?.({
      payload: {
        path: VIDEO.path, framePaths: ["/tmp/f18.jpg", "/tmp/f19.jpg"],
        startIndex: 18, intervalSecs: 16, count: 36, tileW: 400, tileH: 225,
      },
    }));
    expect(result.current.generating).toEqual({ done: 20, count: 36 });
    expect(result.current.tile).toBe(18);
    expect(result.current.position?.secs).toBe(18 * 16 + 8);
    act(() => { vi.advanceTimersByTime(HOVER_FRAME_INTERVAL_MS); });
    expect(result.current.tile).toBe(19);

    // Tile 20 lands while 19 is up: the loop carries on to it, no jump.
    act(() => listeners.get("storyboard-partial")?.({
      payload: {
        path: VIDEO.path, framePaths: ["/tmp/f18.jpg", "/tmp/f19.jpg", "/tmp/f20.jpg"],
        startIndex: 18, intervalSecs: 16, count: 36, tileW: 400, tileH: 225,
      },
    }));
    expect(result.current.tile).toBe(19);
    act(() => { vi.advanceTimersByTime(HOVER_FRAME_INTERVAL_MS); });
    expect(result.current.tile).toBe(20);
    act(() => { vi.advanceTimersByTime(HOVER_FRAME_INTERVAL_MS); });
    expect(result.current.tile).toBe(18);
  });

  it("says it is preparing before the pass has reported a frame", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_storyboard") return Promise.resolve(null);
      if (cmd === "extract_storyboard") return new Promise(() => {});
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useHoverStoryboard(VIDEO, { generate: true }));
    act(() => result.current.hoverProps.onMouseEnter());
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS); });
    await flush();
    expect(result.current.loading).toBe(true);
    expect(result.current.generating).toBeNull();
  });

  it("decodes nothing when seek previews are switched off", async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "get_storyboard" ? null : undefined));
    const { result } = renderHook(() => useHoverStoryboard(VIDEO, { generate: false }));
    act(() => result.current.hoverProps.onMouseEnter());
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS); });
    await flush();
    expect(calls("get_storyboard")).toHaveLength(1);
    expect(calls("extract_storyboard")).toHaveLength(0);
    expect(result.current.tile).toBeNull();
  });

  it("drops the board when the card is recycled for another video", async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "get_storyboard" ? BOARD : undefined));
    const { result, rerender } = renderHook(
      ({ track }) => useHoverStoryboard(track, { generate: true }),
      { initialProps: { track: VIDEO } },
    );
    act(() => result.current.hoverProps.onMouseEnter());
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS); });
    await flush();
    expect(result.current.board).not.toBeNull();

    rerender({ track: { ...VIDEO, path: "file:///music/other.mp4" } });
    expect(result.current.board).toBeNull();
  });
});
