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
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

import {
  useHoverStoryboard,
  hoverPreviewTrack,
  hoverPreviewTiles,
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

    act(() => { vi.advanceTimersByTime(HOVER_FRAME_INTERVAL_MS); });
    expect(result.current.tile).toBe(tiles[1]);

    act(() => result.current.hoverProps.onMouseLeave());
    expect(result.current.tile).toBeNull();
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
