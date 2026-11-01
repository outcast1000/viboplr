// Every track heart reads one store (contexts/TrackLikeContext.tsx), so the
// copies of a song — a queue entry, a plugin row that hardcodes liked: 0, the
// track page — can no longer disagree, library or not.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

// Captures the entity-likes-changed handler so a test can fire the event.
let likesChanged: ((e: { payload: unknown }) => void) | null = null;
vi.mock("../utils/tauriEvents", () => ({
  subscribe: (event: string, handler: (e: { payload: unknown }) => void) => {
    if (event === "entity-likes-changed") likesChanged = handler;
    return () => { if (likesChanged === handler) likesChanged = null; };
  },
  safeUnlisten: () => {},
  combineUnlisten: () => () => {},
}));

import { LikeDislikeButtons } from "../components/LikeDislikeButtons";
import { TrackLikeStoreContext, useTrackLike, useTrackLikeStoreSync } from "../contexts/TrackLikeContext";
import { TrackLikeStore } from "../utils/trackLikeStore";
import { useLikeActions } from "../hooks/useLikeActions";
import { trackLikeKey } from "../likeKeys";
import type { QueueTrack } from "../types";

const JOGA_KEY = trackLikeKey("Jóga", "Björk");

function wrap(store: TrackLikeStore) {
  return ({ children }: { children: ReactNode }) => (
    <TrackLikeStoreContext.Provider value={store}>{children}</TrackLikeStoreContext.Provider>
  );
}

function heartState(label: string): string {
  const btn = screen.getByTitle(new RegExp(`^(Liked|Disliked|Rate) ${label}$`));
  return btn.className.includes(" liked") ? "liked" : btn.className.includes(" disliked") ? "disliked" : "none";
}

afterEach(() => { cleanup(); likesChanged = null; });
beforeEach(() => { invoke.mockReset(); });

describe("track hearts read the like store", () => {
  it("a song that is in no library shows its like on every copy, whatever the copy says", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => [{ key: JOGA_KEY, liked: 1 }]);
    render(
      <TrackLikeStoreContext.Provider value={store}>
        {/* A plugin search row: hardcoded liked 0, different spelling. */}
        <LikeDislikeButtons liked={0} track={{ title: "Joga", artist_name: "Bjork" }} entityLabel="row" onToggleLike={() => {}} />
        {/* A queue entry restored with the manifest's liked 0. */}
        <LikeDislikeButtons liked={0} track={{ title: "Jóga", artist_name: "Björk" }} entityLabel="queue" onToggleLike={() => {}} />
      </TrackLikeStoreContext.Provider>,
    );
    expect(heartState("row")).toBe("liked");
    expect(heartState("queue")).toBe("liked");
  });

  it("shows the copy's own state until the store has loaded, then the store's", async () => {
    const store = new TrackLikeStore();
    render(
      <TrackLikeStoreContext.Provider value={store}>
        <LikeDislikeButtons liked={1} track={{ title: "Jóga", artist_name: "Björk" }} entityLabel="t" onToggleLike={() => {}} />
      </TrackLikeStoreContext.Provider>,
    );
    expect(heartState("t")).toBe("liked");
    await act(() => store.load(async () => [{ key: JOGA_KEY, liked: -1 }]));
    expect(heartState("t")).toBe("disliked");
  });

  it("without a track (artists, albums, tags) the prop is the state, store or not", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => [{ key: JOGA_KEY, liked: 1 }]);
    render(
      <TrackLikeStoreContext.Provider value={store}>
        <LikeDislikeButtons liked={0} entityLabel="artist" onToggleLike={() => {}} />
      </TrackLikeStoreContext.Provider>,
    );
    expect(heartState("artist")).toBe("none");
  });

  it("without a provider, a track heart is exactly the old prop-driven heart", () => {
    render(<LikeDislikeButtons liked={-1} track={{ title: "Jóga", artist_name: "Björk" }} entityLabel="t" onToggleLike={() => {}} />);
    expect(heartState("t")).toBe("disliked");
  });
});

describe("useTrackLikeStoreSync", () => {
  it("loads, applies a single keyed write directly, and reloads on a bulk change", async () => {
    const store = new TrackLikeStore();
    let backend: { key: string; liked: number }[] = [{ key: JOGA_KEY, liked: 1 }];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_track_likes") return backend;
      throw new Error(`unexpected ${cmd}`);
    });
    const { result } = renderHook(
      () => { useTrackLikeStoreSync(store); return useTrackLike({ title: "Jóga", artist_name: "Björk" }, 0); },
      { wrapper: wrap(store) },
    );
    await act(async () => {});
    expect(result.current).toBe(1);
    expect(invoke).toHaveBeenCalledTimes(1);

    // A single write: applied from the payload, no round-trip.
    act(() => likesChanged!({ payload: { kind: "track", key: JOGA_KEY, liked: -1 } }));
    expect(result.current).toBe(-1);
    expect(invoke).toHaveBeenCalledTimes(1);

    // An artist write moves no track like.
    act(() => likesChanged!({ payload: { kind: "artist", key: "artist:bjork", liked: 1 } }));
    expect(invoke).toHaveBeenCalledTimes(1);

    // A bulk import: reload everything.
    backend = [];
    await act(async () => { likesChanged!({ payload: { kind: "bulk" } }); });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(0);
  });
});

describe("like actions read and write the store", () => {
  const TRACK: QueueTrack = {
    key: "q:1", path: null, title: "Jóga", artist_name: "Björk",
    album_title: null, duration_secs: 305, format: null, liked: 0,
  };

  function setup(store: TrackLikeStore) {
    return renderHook(() => useLikeActions({
      library: {
        artists: [], albums: [], tags: [],
        setArtists: vi.fn(), setAlbums: vi.fn(), setTags: vi.fn(),
      },
      plugins: { dispatchEvent: vi.fn() },
      notify: vi.fn(),
      likeStore: store,
    }));
  }

  it("toggles from the song's stored state, not the copy's guess", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => [{ key: JOGA_KEY, liked: 1 }]);
    invoke.mockResolvedValue(1);
    const { result } = setup(store);
    // The copy says 0; the song is liked, so pressing the heart moves on to dislike.
    await act(() => result.current.handleToggleDislike(TRACK));
    expect(invoke).toHaveBeenCalledWith("set_entity_like_state", expect.objectContaining({ likeState: -1 }));
    expect(store.lookupKey(JOGA_KEY)).toBe(-1);
  });

  it("writes the store first and puts the old state back when the save fails", async () => {
    const store = new TrackLikeStore();
    await store.load(async () => []);
    let fail!: (e: Error) => void;
    invoke.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const { result } = setup(store);
    let pending!: Promise<void>;
    act(() => { pending = result.current.handleToggleLike(TRACK); });
    expect(store.lookupKey(JOGA_KEY)).toBe(1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => { fail(new Error("disk")); await pending; });
    expect(store.lookupKey(JOGA_KEY)).toBe(0);
  });
});
