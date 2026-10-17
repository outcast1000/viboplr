import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { QueueTrack, ResolvedTrackSource, EngineSource } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(true) }));
vi.mock("../store", () => ({
  store: { get: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../telemetry", () => ({ track: vi.fn(), sourceClass: () => "local" }));
// Engine events are delivered by hand: each subscribe keeps its handler.
const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("../utils/tauriEvents", () => ({
  subscribe: (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return () => {};
  },
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

import { usePlayback, type PlaybackOutcomeHandlers } from "../hooks/usePlayback";
import { CHAIN_EXHAUSTED_MESSAGE } from "../playback/trackFailures";

const song: QueueTrack = {
  key: "q:1", path: "file:///music/song.flac", title: "Song", artist_name: "Artist",
  album_title: null, duration_secs: 200, format: "flac", liked: 0,
};

const resolved: ResolvedTrackSource = {
  src: "asset://song.flac",
  engineSource: { kind: "file", path: "/music/song.flac" } as EngineSource,
} as ResolvedTrackSource;

function ref<T>(current: T) {
  return { current };
}

function mount(resolve: (t: QueueTrack) => Promise<ResolvedTrackSource>) {
  const outcome: PlaybackOutcomeHandlers = { failed: vi.fn(), started: vi.fn() };
  const hook = renderHook(() =>
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
      undefined,
      ref(outcome),
    ),
  );
  return { ...hook, outcome };
}

function emit(name: string, payload: unknown) {
  const h = handlers.get(name);
  if (!h) throw new Error(`no ${name} subscriber`);
  act(() => h({ payload }));
}

beforeEach(() => {
  handlers.clear();
});

describe("usePlayback → per-entry failure record", () => {
  it("records an engine failure with the player's own error, and clears it once the entry plays", async () => {
    const { result, outcome } = mount(async () => resolved);
    await act(async () => { await result.current.handlePlay(song); });

    // A local file isn't retried: its first engine error is the final one.
    emit("engine-error", { trackKey: "q:1", code: "decode", message: "loading failed (-13)" });
    expect(outcome.failed).toHaveBeenCalledWith("q:1", expect.objectContaining({
      engineError: "loading failed (-13)",
      tries: 1,
    }));

    // Played again and it runs: the record is told, once.
    await act(async () => { await result.current.handlePlay(song); });
    emit("engine-position", { trackKey: "q:1", positionSecs: 0.5 });
    emit("engine-position", { trackKey: "q:1", positionSecs: 0.75 });
    expect(outcome.started).toHaveBeenCalledTimes(1);
    expect(outcome.started).toHaveBeenCalledWith("q:1");
  });

  it("records a play that throws before the engine opens anything", async () => {
    const { result, outcome } = mount(async () => { throw new Error(CHAIN_EXHAUSTED_MESSAGE); });
    await act(async () => { await result.current.handlePlay(song); });
    expect(outcome.failed).toHaveBeenCalledWith("q:1", expect.objectContaining({ summary: CHAIN_EXHAUSTED_MESSAGE }));
    expect(outcome.started).not.toHaveBeenCalled();
  });

  it("a failure after a successful play lets the next success clear it again", async () => {
    const { result, outcome } = mount(async () => resolved);
    await act(async () => { await result.current.handlePlay(song); });
    emit("engine-position", { trackKey: "q:1", positionSecs: 1 });
    emit("engine-error", { trackKey: "q:1", code: "decode", message: "boom" });
    await act(async () => { await result.current.handlePlay(song); });
    emit("engine-position", { trackKey: "q:1", positionSecs: 1 });
    expect(outcome.started).toHaveBeenCalledTimes(2);
  });
});
