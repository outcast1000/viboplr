// The library-first / plugins-when-empty decision lives in hook state
// (weights restored from the store), so it is driven through renderHook.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import type { QueueTrack, Track } from "../types";
import type { AutoContinuePluginBridge } from "../utils/autoContinue";
import type { PluginAutoContinueRequest, PluginTrack } from "../types/plugin";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const storeValues: Record<string, unknown> = {};
vi.mock("../store", () => ({
  store: {
    get: vi.fn(async (key: string) => storeValues[key]),
    set: vi.fn(async () => {}),
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { useAutoContinue } from "../hooks/useAutoContinue";

const mockedInvoke = vi.mocked(invoke);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  for (const k of Object.keys(storeValues)) delete storeValues[k];
});

const current: QueueTrack = {
  key: "q:1", path: null, title: "Jóga", artist_name: "Björk", album_title: "Homogenic",
  duration_secs: 300, format: null, liked: 0,
};

const libraryTrack = { id: 7, path: "file:///x.mp3", title: "Owned", artist_name: "A", album_title: null, format: "mp3", duration_secs: 200, liked: 0 } as unknown as Track;

/** invoke: the library answers `library` for every strategy; `disliked`
 *  titles read as -1. */
function backend(library: Track | null, disliked: string[] = []) {
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "get_auto_continue_track") return library;
    if (cmd === "get_track_like_states") {
      return (args as { tracks: Array<{ title: string }> }).tracks.map((t) => (disliked.includes(t.title) ? -1 : 0));
    }
    throw new Error(`unexpected ${cmd}`);
  });
}

type Answer = PluginTrack[] | null;

/** Stands in for usePlugins' bridge: `answers[i]` is plugin i's reply, handed
 *  to `accept` in order until one is accepted. `nextOnce` swaps the replies for
 *  a single call. */
function bridge(answers: Answer[]) {
  const requests: PluginAutoContinueRequest[] = [];
  let once: Answer[] | null = null;
  const b: AutoContinuePluginBridge & { requests: PluginAutoContinueRequest[]; nextOnce: (a: Answer[]) => void } = {
    hasProviders: () => true,
    async suggest(request, accept) {
      requests.push(request);
      const replies = once ?? answers;
      once = null;
      for (let i = 0; i < replies.length; i++) {
        const tracks = replies[i];
        if (!tracks || tracks.length === 0) continue;
        const accepted = await accept(`plugin-${i}`, tracks);
        if (accepted !== null) return accepted;
      }
      return null;
    },
    requests,
    nextOnce: (a) => { once = a; },
  };
  return b;
}

function mount(b: AutoContinuePluginBridge | null) {
  return renderHook(() => useAutoContinue({ current: true }, { current: b }));
}

async function pick(result: { current: ReturnType<typeof useAutoContinue> }, ctx = {}): Promise<QueueTrack | null> {
  let next: QueueTrack | null = null;
  await act(async () => { next = await result.current.fetchTrack(current, ctx); });
  return next;
}

describe("useAutoContinue", () => {
  it("plays from the library when it has something, without asking plugins", async () => {
    backend(libraryTrack);
    const b = bridge([[{ title: "Suggested", artist_name: "S" }]]);
    const { result } = mount(b);
    expect(await pick(result)).toMatchObject({ title: "Owned", libraryId: 7 });
    expect(b.requests).toHaveLength(0);
  });

  it("asks the plugins when the library has nothing, skipping what was just played", async () => {
    backend(null);
    const b = bridge([[{ title: "Jóga", artist_name: "Björk" }, { title: "Hunter", artist_name: "Björk" }]]);
    const { result } = mount(b);
    const played: QueueTrack = { ...current, key: "q:0", title: "Hyperballad" };
    expect(await pick(result, { recent: [played], sessionSeed: played })).toMatchObject({ title: "Hunter", artist_name: "Björk", path: null });
    const request = b.requests[0];
    expect(request.current).toEqual({ title: "Jóga", artistName: "Björk", albumTitle: "Homogenic", durationSecs: 300 });
    expect(request.sessionSeed).toEqual({ title: "Hyperballad", artistName: "Björk" });
    expect(request.recent.map((r) => r.title)).toEqual(["Hyperballad", "Jóga"]);
  });

  it("skips the library lookups entirely when the library is empty", async () => {
    backend(libraryTrack); // would answer, but must not be asked
    const { result } = mount(bridge([[{ title: "Hunter", artist_name: "Björk" }]]));
    expect(await pick(result, { libraryEmpty: true })).toMatchObject({ title: "Hunter" });
    expect(mockedInvoke).not.toHaveBeenCalledWith("get_auto_continue_track", expect.anything());
  });

  it("asks the next plugin when the first one's suggestions are all unusable", async () => {
    backend(null, ["Hated"]);
    const b = bridge([
      [{ title: "Jóga", artist_name: "Björk" }, { title: "Hated", artist_name: "X" }],
      [{ title: "Fresh", artist_name: "Y" }],
    ]);
    const { result } = mount(b);
    expect(await pick(result)).toMatchObject({ title: "Fresh" });
  });

  it("stops (null) when neither the library nor a plugin has anything", async () => {
    backend(null);
    const { result } = mount(bridge([null]));
    expect(await pick(result)).toBeNull();
  });

  it("asks the plugins first on a Similar pick, and falls back to the library when they have nothing", async () => {
    storeValues.autoContinueWeights = { random: 0, sameArtist: 0, sameTag: 0, mostPlayed: 0, liked: 0, similar: 100 };
    backend(libraryTrack);
    const b = bridge([[{ title: "Hunter", artist_name: "Björk" }]]);
    const { result } = mount(b);
    await waitFor(() => expect(result.current.weights.similar).toBe(100));
    expect(await pick(result)).toMatchObject({ title: "Hunter" });

    b.nextOnce([null]);
    expect(await pick(result)).toMatchObject({ title: "Owned" });
    expect(mockedInvoke).toHaveBeenCalledWith("get_auto_continue_track", expect.objectContaining({ strategy: "random" }));
  });

  it("works with no plugin bridge at all (older wiring)", async () => {
    backend(null);
    const { result } = mount(null);
    expect(await pick(result)).toBeNull();
  });
});
