// Two things about storyboard generation that are invisible from the outside and
// were both once wrong: the ffmpeg pass must not start when the user has switched
// seek previews off, and a pass already running must be withdrawn from when nobody
// is on that video any more (a track skip, a closed view). A generation left to run
// is a full keyframe decode for a video nobody is watching — the only symptom is CPU,
// which no other test would notice.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import type { QueueTrack } from "../types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

import { useStoryboard } from "../hooks/useStoryboard";

const VIDEO: QueueTrack = {
  key: "lib:1",
  title: "A Video",
  artist_name: "Someone",
  album_title: null,
  path: "file:///music/clip.mp4",
  format: "mp4",
} as unknown as QueueTrack;

function calls(command: string) {
  return invoke.mock.calls.filter(c => c[0] === command);
}

describe("useStoryboard generation gate", () => {
  beforeEach(() => {
    invoke.mockReset();
    // Nothing cached, so the hook is on the generate path.
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_storyboard") return Promise.resolve(null);
      if (cmd === "extract_storyboard") return new Promise(() => {}); // runs forever
      return Promise.resolve(undefined);
    });
  });
  afterEach(cleanup);

  it("generates on a cache miss when previews are on", async () => {
    const { result } = renderHook(() => useStoryboard(VIDEO, undefined, null, true));
    await act(async () => { await Promise.resolve(); });
    expect(calls("extract_storyboard")).toHaveLength(1);
    expect(result.current.status).toBe("loading");
  });

  it("decodes nothing when previews are off, but still serves the cache", async () => {
    const { result } = renderHook(() => useStoryboard(VIDEO, undefined, null, false));
    await act(async () => { await Promise.resolve(); });
    expect(calls("get_storyboard")).toHaveLength(1);
    expect(calls("extract_storyboard")).toHaveLength(0);
    expect(result.current.status).toBe("off");
  });

  it("withdraws from a pass in flight when the surface goes away", async () => {
    const { unmount } = renderHook(() => useStoryboard(VIDEO, undefined, null, true));
    await act(async () => { await Promise.resolve(); });
    const requestId = (calls("extract_storyboard")[0][1] as { requestId: string }).requestId;

    unmount();
    expect(calls("cancel_storyboard")).toEqual([
      ["cancel_storyboard", { path: VIDEO.path, requestId }],
    ]);
  });

  it("withdraws from a pass in flight when previews are switched off mid-run", async () => {
    const { rerender } = renderHook(
      ({ on }: { on: boolean }) => useStoryboard(VIDEO, undefined, null, on),
      { initialProps: { on: true } },
    );
    await act(async () => { await Promise.resolve(); });
    await act(async () => { rerender({ on: false }); await Promise.resolve(); });
    expect(calls("cancel_storyboard")).toHaveLength(1);
  });

  it("does not withdraw a request that already settled", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_storyboard") return Promise.resolve(null);
      if (cmd === "extract_storyboard") {
        return Promise.resolve({ status: "unsupported", storyboard: null });
      }
      return Promise.resolve(undefined);
    });
    const { unmount } = renderHook(() => useStoryboard(VIDEO, undefined, null, true));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    unmount();
    expect(calls("cancel_storyboard")).toHaveLength(0);
  });
});
