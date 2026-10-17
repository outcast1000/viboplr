import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { QueueTrack, ResolvedTrackSource, EngineSource } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("../store", () => ({
  store: { get: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../telemetry", () => ({ track: vi.fn(), sourceClass: () => "local" }));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: () => () => {},
  combineUnlisten: () => () => {},
}));
// Every engine control resolves; `play` is the one the tests read back.
vi.mock("../playback/nativeEngine", () => ({
  nativeEngine: new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get(target, prop: string) {
      if (!target[prop]) target[prop] = vi.fn().mockResolvedValue(undefined);
      return target[prop];
    },
  }),
}));

import { usePlayback } from "../hooks/usePlayback";
import { nativeEngine } from "../playback/nativeEngine";

const enginePlay = nativeEngine.play as unknown as ReturnType<typeof vi.fn>;

const song: QueueTrack = {
  key: "q:1", path: "file:///music/song.flac", title: "Song", artist_name: "Artist",
  album_title: null, duration_secs: 200, format: "flac", liked: 0,
};
const clipSource: EngineSource = { kind: "file", path: "/music/clip.flac" } as EngineSource;

function ref<T>(current: T) {
  return { current };
}

function mountPlayback(resolve: (t: QueueTrack) => Promise<ResolvedTrackSource>) {
  return renderHook(() =>
    usePlayback(
      ref(true),
      ref(() => null),
      ref(0),
      ref(() => {}),
      ref(() => ({ offered: false, accepted: false })),
      ref(resolve),
      ref(() => {}),
      ref(true),
      ref(true),
      ref(() => {}),
      ref(null),
    ),
  );
}

const resolved: ResolvedTrackSource = {
  src: "asset://song.flac",
  engineSource: { kind: "file", path: "/music/song.flac" } as EngineSource,
} as ResolvedTrackSource;

beforeEach(() => {
  enginePlay.mockClear();
});

describe("usePlayback clip ownership", () => {
  it("a main play that takes the engine tells the clip's owner", async () => {
    const { result } = mountPlayback(async () => resolved);
    const onLost = vi.fn();
    act(() => { result.current.playClip(clipSource, 30, { onLost }); });
    await act(async () => { await result.current.handlePlay(song); });
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(enginePlay.mock.calls.at(-1)?.[0].trackKey).toBe("q:1");
  });

  it("Stop tells the clip's owner; stopping the clip itself does not", async () => {
    const { result } = mountPlayback(async () => resolved);
    const lostOnStop = vi.fn();
    act(() => { result.current.playClip(clipSource, 0, { onLost: lostOnStop }); });
    act(() => { result.current.handleStop(); });
    expect(lostOnStop).toHaveBeenCalledTimes(1);

    const lostOnOwnStop = vi.fn();
    let key = "";
    act(() => { key = result.current.playClip(clipSource, 0, { onLost: lostOnOwnStop }).key; });
    act(() => { result.current.stopClip(key); });
    act(() => { result.current.handleStop(); });
    expect(lostOnOwnStop).not.toHaveBeenCalled();
  });

  it("a play still resolving when a clip starts is dropped, not opened over the clip", async () => {
    let finishResolve: (r: ResolvedTrackSource) => void = () => {};
    const { result } = mountPlayback(() => new Promise((r) => { finishResolve = r; }));
    const onLost = vi.fn();
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.handlePlay(song); });
    act(() => { result.current.playClip(clipSource, 0, { onLost }); });
    await act(async () => { finishResolve(resolved); await pending; });
    expect(enginePlay.mock.calls.map((c) => c[0].trackKey)).toEqual(["clip:1"]);
    expect(onLost).not.toHaveBeenCalled();
    expect(result.current.loadingTrack).toBeNull();
    expect(result.current.playbackError).toBeNull();
  });
});
