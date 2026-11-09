import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { QueueTrack, ResolvedTrackSource, EngineSource } from "../types";

// A play walking the resolver chain (fallback providers, up to a minute each)
// used to ignore the transport: Stop let it start the music anyway once a
// fallback answered, and Pause — no session open yet — called handlePlay
// again. These pin that Pause and Stop retire the pending play.

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("../store", () => ({
  store: { get: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../telemetry", () => ({ track: vi.fn(), sourceClass: () => "local" }));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: () => () => {},
  combineUnlisten: () => () => {},
}));
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

const first: QueueTrack = {
  key: "q:1", path: "file:///music/a.flac", title: "A", artist_name: "Artist",
  album_title: null, duration_secs: 200, format: "flac",
};
const second: QueueTrack = {
  key: "q:2", path: "spotify://track/xyz", title: "B", artist_name: "Artist",
  album_title: null, duration_secs: 180, format: null,
};

const resolvedFor = (t: QueueTrack): ResolvedTrackSource => ({
  src: `asset://${t.key}`,
  engineSource: { kind: "http", url: `https://example.test/${t.key}` } as EngineSource,
}) as ResolvedTrackSource;

function ref<T>(current: T) {
  return { current };
}

/** Resolves `first` at once; every other track waits for `finish`. */
function mountPlayback() {
  const waiting: Array<(r: ResolvedTrackSource) => void> = [];
  const resolve = vi.fn((t: QueueTrack) =>
    t.key === first.key
      ? Promise.resolve(resolvedFor(t))
      : new Promise<ResolvedTrackSource>((r) => { waiting.push(r); }));
  const hook = renderHook(() =>
    usePlayback(
      ref(true),
      ref(() => null),
      ref(0),
      ref(() => {}),
      ref(() => false),
      ref(resolve),
      ref(() => {}),
      ref(true),
      ref(true),
      ref(() => {}),
      ref(null),
    ),
  );
  const finish = (t: QueueTrack) => waiting.splice(0).forEach((r) => r(resolvedFor(t)));
  return { ...hook, resolve, finish };
}

beforeEach(() => {
  // Clears call counts on every engine mock (the proxy's fns persist across
  // tests); their resolved-value implementations stay.
  vi.clearAllMocks();
});

describe("usePlayback: transport while a play is still resolving", () => {
  it("Stop retires the pending play — the fallback's late answer doesn't start the music", async () => {
    const { result, finish } = mountPlayback();
    await act(async () => { await result.current.handlePlay(first); });
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.handlePlay(second); });
    expect(result.current.loadingTrack?.key).toBe("q:2");

    act(() => { result.current.handleStop(); });
    expect(result.current.loadingTrack).toBeNull();
    expect(result.current.currentTrack?.key).toBe("q:2");

    await act(async () => { finish(second); await pending; });
    expect(enginePlay.mock.calls.map((c) => c[0].trackKey)).toEqual(["q:1"]);
    expect(result.current.playing).toBe(false);
    expect(result.current.playbackError).toBeNull();
  });

  it("Pause cancels the pending play instead of starting another one, and cues its track", async () => {
    const { result, resolve, finish } = mountPlayback();
    await act(async () => { await result.current.handlePlay(first); });
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.handlePlay(second); });
    const resolvesBefore = resolve.mock.calls.length;

    act(() => { result.current.handlePause(); });
    expect(resolve.mock.calls.length).toBe(resolvesBefore);
    expect(result.current.loadingTrack).toBeNull();
    expect(result.current.currentTrack?.key).toBe("q:2");
    // Its own length, not the 200s of the track before it.
    expect(result.current.durationSecs).toBe(180);
    expect(result.current.playing).toBe(false);

    await act(async () => { finish(second); await pending; });
    expect(enginePlay.mock.calls.map((c) => c[0].trackKey)).toEqual(["q:1"]);
    expect(result.current.playing).toBe(false);
  });

  it("a play request while paused leaves the pending play to land — it doesn't cancel or restart it", async () => {
    // Media-key "play", the control API's play:true and a visualizer's
    // setPlaying(true) all reach handlePause as a toggle when `playing` is false.
    const { result, resolve, finish } = mountPlayback();
    await act(async () => { await result.current.handlePlay(first); });
    act(() => { result.current.handlePause(); });
    expect(result.current.playing).toBe(false);
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.handlePlay(second); });
    const resolvesBefore = resolve.mock.calls.length;

    act(() => { result.current.handlePause(); });
    expect(resolve.mock.calls.length).toBe(resolvesBefore);
    expect(result.current.loadingTrack?.key).toBe("q:2");

    await act(async () => { finish(second); await pending; });
    expect(enginePlay.mock.calls.map((c) => c[0].trackKey)).toEqual(["q:1", "q:2"]);
    expect(result.current.playing).toBe(true);
  });

  it("once the source reached the engine, Pause acts on the session, not on the play", async () => {
    const { result } = mountPlayback();
    let openEngine: () => void = () => {};
    enginePlay.mockImplementationOnce(() => new Promise<void>((r) => { openEngine = r; }));
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.handlePlay(first); });
    await act(async () => { await Promise.resolve(); });
    expect(enginePlay).toHaveBeenCalledTimes(1);

    // Nothing pending any more: with `playing` still false, Pause is a play
    // request on the open session (resume), not a cancel that would race the
    // engine opening the file.
    act(() => { result.current.handlePause(); });
    expect(nativeEngine.stop).not.toHaveBeenCalled();
    await act(async () => { openEngine(); await pending; });
    expect(result.current.currentTrack?.key).toBe("q:1");
    expect(result.current.playing).toBe(true);
  });

  it("a row play asks for its own source only; the same entry's replays inherit it, other plays don't", async () => {
    const { result, resolve } = mountPlayback();
    const exactOf = () => ((resolve.mock.calls.at(-1) as unknown[] | undefined)?.[1] as { exactSource?: boolean } | undefined)?.exactSource;

    await act(async () => { await result.current.handlePlay(first, "user", { exactSource: true }); });
    expect(exactOf()).toBe(true);
    // An engine-error replay of the same entry (comes through as "auto").
    await act(async () => { await result.current.handlePlay(first, "auto"); });
    expect(exactOf()).toBe(true);
    // A Pause→Play resume of that entry with no session open keeps it.
    act(() => { result.current.handleStop(); });
    await act(async () => { result.current.handlePause(); await Promise.resolve(); });
    expect(exactOf()).toBe(true);
    // Next / a list's Play / end of track: the whole chain.
    await act(async () => { await result.current.handlePlay(first, "user"); });
    expect(exactOf()).toBe(false);
  });

  it("Pause with nothing pending still toggles the open session", async () => {
    const { result } = mountPlayback();
    await act(async () => { await result.current.handlePlay(first); });
    expect(result.current.playing).toBe(true);
    act(() => { result.current.handlePause(); });
    expect(result.current.playing).toBe(false);
    expect(nativeEngine.setPaused).toHaveBeenCalledWith(true);
  });
});
