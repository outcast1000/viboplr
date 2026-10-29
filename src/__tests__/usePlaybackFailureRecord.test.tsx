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
import { clearAllNativeRetries, noteResolvedEntry, failedEntryCount } from "../playback/playbackRetry";

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

function mount(resolve: (t: QueueTrack) => Promise<ResolvedTrackSource>, opts: { engine?: boolean } = {}) {
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
      ref(opts.engine ?? true),
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
      stage: "playback",
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
    // Nothing reached the engine, so it is a resolve failure, not a source
    // the player rejected.
    expect(outcome.failed).toHaveBeenCalledWith("q:1", expect.objectContaining({
      stage: "resolve",
      summary: CHAIN_EXHAUSTED_MESSAGE,
    }));
    expect(outcome.started).not.toHaveBeenCalled();
  });

  it("a probe answering after the user played again doesn't bring the note back", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    let answerProbe: (exists: boolean) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "file_exists") return new Promise<boolean>((r) => { answerProbe = r; });
      return true;
    });
    try {
      const { result, outcome } = mount(async () => resolved);
      await act(async () => { await result.current.handlePlay(song); });
      emit("engine-error", { trackKey: "q:1", code: "decode", message: "loading failed (-13)" });
      expect(outcome.failed).toHaveBeenCalledTimes(1);
      // Try again, and it plays — before the disk probe has answered.
      await act(async () => { await result.current.handlePlay(song); });
      emit("engine-position", { trackKey: "q:1", positionSecs: 0.5 });
      await act(async () => { answerProbe(false); });
      expect(outcome.failed).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(invoke).mockReset();
      vi.mocked(invoke).mockResolvedValue(true);
    }
  });

  it("plays the next source in the chain before calling a failure", async () => {
    // A two-entry chain: each resolve answers from the first entry not yet
    // failed, as useStreamResolution does.
    clearAllNativeRetries();
    const resolve = vi.fn(async (t: QueueTrack) => {
      noteResolvedEntry(t.key, failedEntryCount(t.key), 2);
      return resolved;
    });
    const { result, outcome } = mount(resolve);
    await act(async () => { await result.current.handlePlay(song); });

    // The track's own source fails: no failure yet, the track is played again.
    await act(async () => {
      emit("engine-error", { trackKey: "q:1", code: "decode", message: "loading failed (-13)" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(outcome.failed).not.toHaveBeenCalled();

    // The fallback fails too and nothing is left: now it's a failure.
    emit("engine-error", { trackKey: "q:1", code: "decode", message: "loading failed (-13)" });
    expect(outcome.failed).toHaveBeenCalledTimes(1);
    clearAllNativeRetries();
  });

  it("a local file the decoder rejects fails at once instead of searching the chain", async () => {
    // The chain would offer the Library copy (the same file) and then the
    // plugin resolvers, which search the web by the file's name.
    clearAllNativeRetries();
    const resolve = vi.fn(async (t: QueueTrack) => {
      noteResolvedEntry(t.key, failedEntryCount(t.key), 3);
      return resolved;
    });
    const { result, outcome } = mount(resolve);
    await act(async () => { await result.current.handlePlay(song); });

    emit("engine-error", { trackKey: "q:1", code: "decode", message: "unrecognized file format (-17)" });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(outcome.failed).toHaveBeenCalledTimes(1);
    clearAllNativeRetries();
  });

  it("files a missing engine as an engine failure, not a rejected source", async () => {
    const { result, outcome } = mount(async () => resolved, { engine: false });
    await act(async () => { await result.current.handlePlay(song); });
    expect(outcome.failed).toHaveBeenCalledWith("q:1", expect.objectContaining({ stage: "engine" }));
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
