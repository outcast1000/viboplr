import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// The chain lives in hook state (it is rebuilt per resolve off a dozen refs), so
// there is no pure function to point at — mount the hook and drive the resolver
// it publishes. The library-copy fallback is the real `createLibraryStreamResolver`
// passed through `streamResolversRef`, exactly as App.tsx wires it, so these
// tests cover the chain and the resolver together: entry ordering, the
// local→network copy walk, the `file_exists` guard, and `patch` reclassification.

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  // Mirrors the real thing closely enough to prove which path won: on Windows
  // convertFileSrc yields an asset URL, which is exactly why `src` alone can't
  // be classified and the chain carries `engineSource` separately.
  convertFileSrc: (p: string) => `asset://${p}`,
}));

import { useStreamResolution } from "../hooks/useStreamResolution";
import { createLibraryStreamResolver } from "../streamResolvers";
import type { QueueTrack, ResolvedTrackSource } from "../types";
import type { StreamCandidate } from "../types/plugin";

const QBT_TRACK: QueueTrack = {
  key: "ext:4",
  path: "qbt://abc123/5",
  title: "Nothingman",
  artist_name: "Pearl Jam",
  album_title: "Vitalogy",
  duration_secs: 276,
  format: null,
  liked: 0,
};

/** The library row that outlived its file — collection root + "/" + relative
 *  path, exactly as `db/tracks.rs` composes `'file://' || co.path || '/' || t.path`. */
const STALE_LIBRARY_PATH = "D:\\Music\\- Garage/Pearl Jam - Nothingman.mp3";

const SUBSONIC_COPY_PATH = "subsonic://navidrome.example/42";
const SUBSONIC_STREAM_URL = "https://navidrome.example/rest/stream.view?id=42";

interface Opts {
  /** What `find_tracks_by_metadata` answers — every copy, local first. */
  libraryMatches?: Array<{ path: string; format: string | null }>;
  /** What `file_exists` answers for a matched local path. */
  fileOnDisk?: boolean;
  /** What the `qbt` by-URI resolver hands back. */
  uriResult?: { url: string; candidates?: StreamCandidate[]; sourceUrl?: string };
  /** Make the track's own source fail, so the chain has to fall through. */
  uriFails?: boolean;
  /** Drop the track's `path`, as a Home track-row or a metadata-only result has. */
  pathless?: boolean;
}

function mountChain(opts: Opts = {}) {
  const {
    libraryMatches = [],
    fileOnDisk = true,
    uriResult = { url: "file://D:/Torrents/Vitalogy/05. Nothingman.mp3" },
    uriFails = false,
    pathless = false,
  } = opts;

  invoke.mockImplementation((cmd: string) => {
    if (cmd === "find_tracks_by_metadata") return Promise.resolve(libraryMatches);
    if (cmd === "file_exists") return Promise.resolve(fileOnDisk);
    if (cmd === "resolve_subsonic_location") return Promise.resolve(SUBSONIC_STREAM_URL);
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });

  const track: QueueTrack = pathless ? { ...QBT_TRACK, path: null } : QBT_TRACK;
  const resolveTrackSrcRef = { current: null as unknown as (t: QueueTrack) => Promise<ResolvedTrackSource> };
  const resolveStreamByUri = uriFails
    ? vi.fn().mockRejectedValue(new Error("that torrent is no longer in qBittorrent"))
    : vi.fn().mockResolvedValue(uriResult);

  renderHook(() =>
    useStreamResolution({
      resolveTrackSrcRef: resolveTrackSrcRef as never,
      transcodeSessionRef: { current: null } as never,
      resolveStreamByUriRef: { current: resolveStreamByUri } as never,
      streamResolversRef: { current: [createLibraryStreamResolver()] },
      resolveStreamByUri,
      streamUriResolverOwner: (scheme: string) => (scheme === "qbt" ? "qbittorrent" : null),
      pluginNames: new Map([["qbittorrent", "qBittorrent"]]),
      requireDep: vi.fn().mockResolvedValue(true),
      useNativeVideoRef: { current: true },
      preferVideoRef: { current: false },
      queue: [track],
      currentTrack: null,
      notify: vi.fn(),
    }),
  );

  return { resolve: () => resolveTrackSrcRef.current(track), resolveStreamByUri };
}

beforeEach(() => {
  invoke.mockReset();
});

describe("chain order: the track's own source, then a library copy of it", () => {
  it("plays the exact file that was clicked, not a title+artist match", async () => {
    // The original bug this order exists for. A library row for the same
    // title/artist used to be tried FIRST, and find_tracks_by_metadata is fuzzy
    // about WHICH copy, so clicking "05. Nothingman.mp3" inside a Vitalogy
    // torrent resolved to "Pearl Jam - Nothingman.mp3" in an unrelated
    // compilation folder — a different recording. (Here that file is present,
    // so the old order really would have played it.)
    const { resolve, resolveStreamByUri } = mountChain({
      libraryMatches: [{ path: `file://${STALE_LIBRARY_PATH}`, format: "mp3" }],
      fileOnDisk: true,
    });

    const out = await resolve();

    expect(resolveStreamByUri).toHaveBeenCalledWith("qbt", "abc123/5", null, undefined);
    expect(out.engineSource).toEqual({ kind: "file", path: "D:/Torrents/Vitalogy/05. Nothingman.mp3" });
    expect(out.src).not.toContain("- Garage");
  });

  it("falls back to the library copy when the track's own source fails", async () => {
    const { resolve, resolveStreamByUri } = mountChain({
      libraryMatches: [{ path: `file://${STALE_LIBRARY_PATH}`, format: "mp3" }],
      fileOnDisk: true,
      uriFails: true,
    });

    const out = await resolve();

    expect(resolveStreamByUri).toHaveBeenCalled();
    expect(out.engineSource).toEqual({ kind: "file", path: STALE_LIBRARY_PATH });
    // The matched row's path + format ride along so a path-less track can be
    // reclassified from the copy that actually plays, and so `currentTrack`
    // learns the real file behind the play (Show in folder, the tag probe).
    expect(out.patch).toEqual({ path: `file://${STALE_LIBRARY_PATH}`, format: "mp3" });
  });

  it("falls through a local row whose file is gone to the network copy", async () => {
    // A row outlives its file. Resolving it "successfully" hands mpv a path
    // that can't load — a *playback* failure, which never advances the chain.
    // The Library resolver checks `file_exists` and walks the next copy of the
    // same match instead, so the Subsonic copy plays.
    const { resolve } = mountChain({
      libraryMatches: [
        { path: `file://${STALE_LIBRARY_PATH}`, format: "mp3" },
        { path: SUBSONIC_COPY_PATH, format: "mp3" },
      ],
      fileOnDisk: false,
      uriFails: true,
    });

    const out = await resolve();

    expect(out.src).toBe(SUBSONIC_STREAM_URL);
    expect(out.engineSource).toEqual({ kind: "http", url: SUBSONIC_STREAM_URL });
  });

  it("fails rather than handing back a dead path when no copy is playable", async () => {
    const { resolve } = mountChain({
      libraryMatches: [{ path: `file://${STALE_LIBRARY_PATH}`, format: "mp3" }],
      fileOnDisk: false,
      uriFails: true,
    });

    await expect(resolve()).rejects.toThrow(/Couldn't find a playable source/);
  });

  it("serves a track with no source of its own from the library", async () => {
    // A Home track-row carries only title + artist, so there is no native
    // entry — the Library resolver is the first thing in the chain, and its
    // `patch` is what classifies the track from the file that was matched.
    const { resolve, resolveStreamByUri } = mountChain({
      pathless: true,
      libraryMatches: [{ path: `file://${STALE_LIBRARY_PATH}`, format: "mp3" }],
      fileOnDisk: true,
    });

    const out = await resolve();

    expect(resolveStreamByUri).not.toHaveBeenCalled();
    expect(out.engineSource).toEqual({ kind: "file", path: STALE_LIBRARY_PATH });
  });
});

describe("classifying a plugin scheme from the file it resolves to", () => {
  it("patches the container so a downloaded video reaches the theater", async () => {
    // `qbt://abc123/5` carries no extension, so the track arrives as audio and
    // played through the <audio> element: sound, no picture. The resolution knows
    // the real filename, so it names the container.
    const { resolve } = mountChain({
      uriResult: { url: "file://D:/Torrents/Concert.2019.1080p.mkv" },
    });

    const out = await resolve();

    expect(out.patch).toEqual({ format: "mkv" });
  });

  it("leaves an audio file unpatched", async () => {
    // Only ever ADDS a video classification — an audio container is already
    // handled correctly and writing `format` for it would be noise.
    const { resolve } = mountChain({
      uriResult: { url: "file://D:/Torrents/Vitalogy/05. Nothingman.mp3" },
    });

    const out = await resolve();

    expect(out.patch).toBeUndefined();
  });

  it("works when the plugin reports no sourceUrl at all", async () => {
    // Derived from `engineSource.path` via attributedSourceUrl, so a plugin built
    // against an older host (which can't take the object form) still gets this.
    const { resolve } = mountChain({
      uriResult: { url: "file://D:/Torrents/Concert.mkv" },
    });

    expect((await resolve()).patch).toEqual({ format: "mkv" });
  });
});
