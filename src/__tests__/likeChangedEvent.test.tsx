// The `like:changed` plugin event: sent for every like / dislike / un-like the
// user makes, on any entity, only after the write succeeded — what the
// Community plugin forwards to the server.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useLikeActions } from "../hooks/useLikeActions";
import { trackLikeChange, entityLikeChange, entityLikePayload } from "../likeKeys";
import type { Album, Artist, QueueTrack } from "../types";

const TRACK: QueueTrack = {
  key: "q:1", path: "file:///m/joga.flac", title: "Jóga", artist_name: "Björk",
  album_title: "Homogenic", album_artist_name: "Björk", duration_secs: 305, format: "flac", liked: 0,
};

function setup(over: { artists?: Artist[]; albums?: Album[] } = {}) {
  const dispatchEvent = vi.fn();
  const notify = vi.fn();
  const library = {
    tracks: [], artists: over.artists ?? [], albums: over.albums ?? [], tags: [],
    setTracks: vi.fn(), setArtists: vi.fn(), setAlbums: vi.fn(), setTags: vi.fn(),
  };
  const { result } = renderHook(() =>
    useLikeActions({
      library,
      playback: { currentTrack: null, setCurrentTrack: vi.fn() },
      queueHook: { setQueue: vi.fn() },
      plugins: { dispatchEvent },
      notify,
    }),
  );
  const changes = () => dispatchEvent.mock.calls.filter(([e]) => e === "like:changed").map(([, c]) => c);
  return { result, changes, notify };
}

// set_entity_like_state answers the stored state it replaced; `stored` seeds it.
let stored: Record<string, number> = {};
beforeEach(() => {
  stored = {};
  invoke.mockReset();
  invoke.mockImplementation(async (_cmd: string, args: { kind: string; entity: { title: string; artistName?: string | null }; likeState: number }) => {
    const key = `${args.kind}:${args.entity.artistName ?? ""}:${args.entity.title}`;
    const previous = stored[key] ?? 0;
    stored[key] = args.likeState;
    return previous;
  });
});

describe("like:changed", () => {
  it("reports a track like with the state it replaced", async () => {
    const { result, changes } = setup();
    await act(() => result.current.handleToggleLike(TRACK));
    expect(changes()).toEqual([
      { kind: "track", name: "Jóga", artistName: "Björk", albumTitle: "Homogenic", albumArtistName: "Björk", liked: 1, previous: 0 },
    ]);
  });

  it("reports dislikes and un-likes too, not only likes", async () => {
    stored["track:Björk:Jóga"] = 1;
    const { result, changes } = setup();
    await act(() => result.current.handleToggleDislike({ ...TRACK, liked: 1 }));
    stored["track:Björk:Jóga"] = 1;
    await act(() => result.current.handleToggleLike({ ...TRACK, liked: 1 }));
    expect(changes().map((c) => [c.liked, c.previous])).toEqual([[-1, 1], [0, 1]]);
  });

  it("reports artist and album likes by name, the album with its album artist", async () => {
    stored["album:Björk:Homogenic"] = 1;
    const { result, changes } = setup({
      artists: [{ id: 3, name: "Björk", track_count: 9, liked: 0 } as Artist],
      albums: [{ id: 5, title: "Homogenic", artist_name: "Björk", liked: 1 } as Album],
    });
    await act(() => result.current.handleToggleArtistLike(3));
    await act(() => result.current.handleToggleAlbumLike(5));
    await act(async () => { await result.current.setAlbumLike("Post", "Björk", 1); });
    expect(changes()).toEqual([
      entityLikeChange("artist", entityLikePayload("Björk"), 1, 0),
      entityLikeChange("album", entityLikePayload("Homogenic", "Björk"), 0, 1),
      entityLikeChange("album", entityLikePayload("Post", "Björk"), 1, 0),
    ]);
    expect(changes()[0].artistName).toBeNull();
    expect(changes()[1].artistName).toBe("Björk");
  });

  it("is not sent when the write fails", async () => {
    invoke.mockRejectedValue(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, changes, notify } = setup();
    await act(() => result.current.handleToggleLike(TRACK));
    expect(changes()).toEqual([]);
    expect(notify).toHaveBeenCalled();
  });

  it("is not sent for an idempotent set that changed nothing", async () => {
    stored["track:Björk:Jóga"] = 1;
    const { result, changes } = setup();
    await act(async () => { await result.current.setTrackRating({ ...TRACK, liked: 1 }, 1); });
    await act(async () => { await result.current.setAlbumLike("Post", "Björk", 0); });
    expect(changes()).toEqual([]);
  });

  it("takes previous from the store, not from a stale copy", async () => {
    // A non-library album has no row to carry its like: the hook assumes 0,
    // but the store knows it was liked, so un-liking it is a real change.
    stored["album:Björk:Post"] = 1;
    const { result, changes } = setup();
    await act(async () => { await result.current.setAlbumLike("Post", "Björk", 0); });
    expect(changes()).toEqual([entityLikeChange("album", entityLikePayload("Post", "Björk"), 0, 1)]);
  });

  it("is the only like event — nothing else is dispatched, whichever button", async () => {
    const dispatchEvent = vi.fn();
    const { result } = renderHook(() =>
      useLikeActions({
        library: { tracks: [], artists: [], albums: [], tags: [], setTracks: vi.fn(), setArtists: vi.fn(), setAlbums: vi.fn(), setTags: vi.fn() },
        playback: { currentTrack: null, setCurrentTrack: vi.fn() },
        queueHook: { setQueue: vi.fn() },
        plugins: { dispatchEvent },
        notify: vi.fn(),
      }),
    );
    await act(() => result.current.handleToggleLike(TRACK));
    stored["track:Björk:Jóga"] = 1;
    // The single like button's step from liked: dislike.
    await act(() => result.current.handleToggleDislike({ ...TRACK, liked: 1 }));
    expect(dispatchEvent.mock.calls.map(([e]) => e)).toEqual(["like:changed", "like:changed"]);
  });

  it("builds the track change from either track shape", () => {
    expect(trackLikeChange({ ...TRACK, artist_name: null, album_title: null, album_artist_name: undefined }, 1, -1)).toEqual({
      kind: "track", name: "Jóga", artistName: null, albumTitle: null, albumArtistName: null, liked: 1, previous: -1,
    });
  });
});
