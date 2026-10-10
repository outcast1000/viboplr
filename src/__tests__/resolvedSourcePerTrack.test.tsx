import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// `resolvedSource` is the now-playing source label / download plan. It is read
// off the CURRENT track's entry, so pre-resolving the next track can never
// relabel the one playing — and once that next track takes over (handlePlay
// reusing the preload, or a gapless/crossfade hand-off that resolves nothing)
// its source is already known.

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

import { useStreamResolution } from "../hooks/useStreamResolution";
import type { QueueTrack, ResolvedTrackSource } from "../types";

function track(key: string, id: string): QueueTrack {
  return { key, path: `qbt://${id}`, title: `Song ${id}`, artist_name: "Artist", album_title: null, duration_secs: 200, format: null, liked: 0 };
}

const A = track("q:1", "a");
const B = track("q:2", "b");

function mount() {
  // Nothing on this path needs the backend (the chunk relay is off for a
  // plain https answer); answer anything else with null.
  invoke.mockResolvedValue(null);
  const resolveTrackSrcRef = { current: null as unknown as (t: QueueTrack, opts?: { preload?: boolean }) => Promise<ResolvedTrackSource> };
  const resolveStreamByUri = vi.fn((_scheme: string, id: string) => Promise.resolve({ url: `https://cdn.example/${id}.mp3` }));
  const hook = renderHook(
    ({ currentTrack }: { currentTrack: QueueTrack | null }) =>
      useStreamResolution({
        resolveTrackSrcRef: resolveTrackSrcRef as never,
        transcodeSessionRef: { current: null } as never,
        resolveStreamByUriRef: { current: resolveStreamByUri } as never,
        streamResolversRef: { current: [] },
        resolveStreamByUri,
        streamUriResolverOwner: (scheme: string) => (scheme === "qbt" ? "qbittorrent" : null),
        pluginNames: new Map([["qbittorrent", "qBittorrent"]]),
        requireDep: vi.fn().mockResolvedValue(true),
        useNativeVideoRef: { current: true },
        preferVideoRef: { current: false },
        queue: [A, B],
        currentTrack,
        notify: vi.fn(),
      }),
    { initialProps: { currentTrack: A as QueueTrack | null } },
  );
  return { hook, resolve: (t: QueueTrack, opts?: { preload?: boolean }) => resolveTrackSrcRef.current(t, opts) };
}

beforeEach(() => { invoke.mockReset(); });

describe("resolvedSource follows the current track", () => {
  it("a preload of the next track does not relabel the playing one", async () => {
    const { hook, resolve } = mount();
    await act(async () => { await resolve(A); });
    expect(hook.result.current.resolvedSource?.url).toBe("https://cdn.example/a.mp3");

    await act(async () => { await resolve(B, { preload: true }); });
    expect(hook.result.current.resolvedSource?.url).toBe("https://cdn.example/a.mp3");
  });

  it("the preloaded track's source shows as soon as it becomes current", async () => {
    const { hook, resolve } = mount();
    await act(async () => { await resolve(A); });
    await act(async () => { await resolve(B, { preload: true }); });

    // A gapless / crossfade hand-off: no further resolve, only currentTrack moves.
    hook.rerender({ currentTrack: B });
    expect(hook.result.current.resolvedSource?.url).toBe("https://cdn.example/b.mp3");
  });

  it("a track with no resolved source yet reads as unknown, not as the previous one", async () => {
    const { hook, resolve } = mount();
    await act(async () => { await resolve(A); });
    hook.rerender({ currentTrack: B });
    expect(hook.result.current.resolvedSource).toBeNull();
  });
});
