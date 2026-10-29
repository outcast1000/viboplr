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
  // Nothing on this path needs the backend; answer anything with null.
  invoke.mockResolvedValue(null);
  const resolveTrackSrcRef = { current: null as unknown as (t: QueueTrack, opts?: { preload?: boolean }) => Promise<ResolvedTrackSource> };
  const resolveStreamByUri = vi.fn((_scheme: string, id: string) => Promise.resolve({ url: `https://cdn.example/${id}.mp3` }));
  const hook = renderHook(
    ({ currentTrack }: { currentTrack: QueueTrack | null }) =>
      useStreamResolution({
        resolveTrackSrcRef: resolveTrackSrcRef as never,
        resolveStreamByUriRef: { current: resolveStreamByUri } as never,
        streamResolversRef: { current: [] },
        resolveStreamByUri,
        streamUriResolverOwner: (scheme: string) => (scheme === "qbt" ? "qbittorrent" : null),
        pluginNames: new Map([["qbittorrent", "qBittorrent"]]),
        useNativeVideoRef: { current: true },
        preferVideoRef: { current: false },
        queue: [A, B],
        currentTrack,
        notify: vi.fn(),
      }),
    { initialProps: { currentTrack: A as QueueTrack | null } },
  );
  return { hook, resolveStreamByUri, resolve: (t: QueueTrack, opts?: { preload?: boolean }) => resolveTrackSrcRef.current(t, opts) };
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

// The resolve cache is keyed by queue key, so it must also check WHICH song it
// holds: a Latest play card brought back a key from an earlier launch, the
// same key a mixtape track had just been given, and the 12s success cache
// handed King Park Hurricane's file — the engine played one song under the
// other's title.
describe("the resolve cache never serves another song under a reused key", () => {
  it("a different song under the same key resolves its own source", async () => {
    const { resolve } = mount();
    const hurricane = { ...track("q:4", "hurricane"), title: "Hurricane", artist_name: "Kyuss" };
    const kingPark = { ...track("q:4", "king-park"), title: "King Park", artist_name: "La Dispute" };
    let first!: ResolvedTrackSource;
    let second!: ResolvedTrackSource;
    await act(async () => { first = await resolve(hurricane); });
    await act(async () => { second = await resolve(kingPark); });
    expect(first.src).toBe("https://cdn.example/hurricane.mp3");
    expect(second.src).toBe("https://cdn.example/king-park.mp3");
  });

  it("a different song doesn't join a resolve still in flight under its key", async () => {
    // A preload of one song is still out when a play of another arrives under
    // the same key. (Two overlapping *plays* are a different rule: the newer
    // supersedes the older, which then answers an empty src.)
    const { resolve } = mount();
    const a = { ...track("q:4", "one"), title: "One" };
    const b = { ...track("q:4", "two"), title: "Two" };
    let ra!: ResolvedTrackSource;
    let rb!: ResolvedTrackSource;
    await act(async () => { [ra, rb] = await Promise.all([resolve(a, { preload: true }), resolve(b)]); });
    expect(ra.src).toBe("https://cdn.example/one.mp3");
    expect(rb.src).toBe("https://cdn.example/two.mp3");
  });

  it("the same entry asked again still hits the cache", async () => {
    // What the cache is for: the engine-error retry and the per-tick preload
    // re-asking for the entry that is already resolved.
    const { resolve, resolveStreamByUri } = mount();
    await act(async () => { await resolve(A); });
    const after = resolveStreamByUri.mock.calls.length;
    await act(async () => { await resolve({ ...A }); });
    expect(after).toBeGreaterThan(0);
    expect(resolveStreamByUri.mock.calls.length).toBe(after);
  });
});
