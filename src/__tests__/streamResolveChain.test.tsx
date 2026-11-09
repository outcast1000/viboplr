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

import { useStreamResolution, skippedAttempt } from "../hooks/useStreamResolution";
import { fallBackFromFailedSource, clearAllNativeRetries } from "../playback/playbackRetry";
import { createLibraryStreamResolver } from "../streamResolvers";
import type { QueueTrack, ResolvedTrackSource } from "../types";
import type { StreamCandidate } from "../types/plugin";
import type { StreamResolver } from "../streamResolvers";

const QBT_TRACK: QueueTrack = {
  key: "ext:4",
  path: "qbt://abc123/5",
  title: "Nothingman",
  artist_name: "Pearl Jam",
  album_title: "Vitalogy",
  duration_secs: 276,
  format: null,
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
  /** The user's "Prefer video" toggle. */
  preferVideo?: boolean;
  /** Metadata resolvers after the library one (a plugin's playback fallback). */
  extraResolvers?: StreamResolver[];
}

function mountChain(opts: Opts = {}) {
  const {
    libraryMatches = [],
    fileOnDisk = true,
    uriResult = { url: "file://D:/Torrents/Vitalogy/05. Nothingman.mp3" },
    uriFails = false,
    pathless = false,
    preferVideo = false,
    extraResolvers = [],
  } = opts;

  invoke.mockImplementation((cmd: string) => {
    if (cmd === "find_tracks_by_metadata") return Promise.resolve(libraryMatches);
    if (cmd === "file_exists") return Promise.resolve(fileOnDisk);
    if (cmd === "resolve_subsonic_location") return Promise.resolve(SUBSONIC_STREAM_URL);
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });

  const track: QueueTrack = pathless ? { ...QBT_TRACK, path: null } : QBT_TRACK;
  const resolveTrackSrcRef = { current: null as unknown as (t: QueueTrack, o?: { exactSource?: boolean }) => Promise<ResolvedTrackSource> };
  const resolveStreamByUri = uriFails
    ? vi.fn().mockRejectedValue(new Error("that torrent is no longer in qBittorrent"))
    : vi.fn().mockResolvedValue(uriResult);
  const notify = vi.fn();

  const { result } = renderHook(() =>
    useStreamResolution({
      resolveTrackSrcRef: resolveTrackSrcRef as never,
      resolveStreamByUriRef: { current: resolveStreamByUri } as never,
      streamResolversRef: { current: [createLibraryStreamResolver(), ...extraResolvers] },
      resolveStreamByUri,
      streamUriResolverOwner: (scheme: string) => (scheme === "qbt" ? "qbittorrent" : null),
      pluginNames: new Map([["qbittorrent", "qBittorrent"]]),
      useNativeVideoRef: { current: true },
      preferVideoRef: { current: preferVideo },
      queue: [track],
      // The track being resolved is the playing one — `resolvedSource` describes
      // the current track only.
      currentTrack: track,
      notify,
    }),
  );

  return {
    resolve: () => resolveTrackSrcRef.current(track),
    /** A row's play button: the track's own source only. */
    resolveExact: () => resolveTrackSrcRef.current(track, { exactSource: true }),
    resolveStreamByUri,
    notify,
    result,
  };
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

  it("after the engine gave up on the track's own source, plays the next entry instead", async () => {
    // A source that resolves fine but can't be played — a Subsonic id gone
    // after a server rescan — never failed the chain, so a replay re-picked it.
    // Falling back makes the next resolve start after it: here the library's
    // network copy under its current path.
    clearAllNativeRetries();
    const { resolve, resolveStreamByUri } = mountChain({
      libraryMatches: [{ path: SUBSONIC_COPY_PATH, format: "mp3" }],
    });
    const first = await resolve();
    expect(first.engineSource).toEqual({ kind: "file", path: "D:/Torrents/Vitalogy/05. Nothingman.mp3" });

    expect(fallBackFromFailedSource(QBT_TRACK.key)).toBe(true);
    const second = await resolve();
    expect(resolveStreamByUri).toHaveBeenCalledTimes(1);
    expect(second.src).toBe(SUBSONIC_STREAM_URL);
    // The library copy was the last entry: nothing further to fall back to.
    expect(fallBackFromFailedSource(QBT_TRACK.key)).toBe(false);
    clearAllNativeRetries();
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

describe("a row's play button: the row's own file and nothing else", () => {
  const fallback: StreamResolver = {
    id: "ytdlp", name: "yt-dlp", source: "ytdlp",
    resolve: vi.fn().mockResolvedValue({ url: "https://youtube.example/stream", video: false }),
  } as unknown as StreamResolver;

  it("fails visibly instead of playing a library copy or a plugin fallback", async () => {
    const { resolveExact, result } = mountChain({
      libraryMatches: [{ path: `file://${STALE_LIBRARY_PATH}`, format: "mp3" }],
      fileOnDisk: true,
      uriFails: true,
      extraResolvers: [fallback],
    });

    await expect(resolveExact()).rejects.toThrow(/Couldn't find a playable source/);
    expect(invoke).not.toHaveBeenCalledWith("find_tracks_by_metadata", expect.anything());
    expect(fallback.resolve).not.toHaveBeenCalled();
    // The row's failure note names only its own source.
    await vi.waitFor(() => expect(result.current.trackFailures[QBT_TRACK.key]?.attempts.map((a) => a.name)).toEqual(["qBittorrent"]));
    // …and says it was a row play, so the dialog's Try again keeps the rule.
    expect(result.current.trackFailures[QBT_TRACK.key]?.ownSourceOnly).toBe(true);
  });

  it("skips the Prefer video pass", async () => {
    const { resolveExact } = mountChain({ preferVideo: true, extraResolvers: [fallback] });
    const out = await resolveExact();
    expect(fallback.resolve).not.toHaveBeenCalled();
    expect(out.engineSource).toEqual({ kind: "file", path: "D:/Torrents/Vitalogy/05. Nothingman.mp3" });
  });

  it("leaves nothing for the engine-error fallback to move to", async () => {
    clearAllNativeRetries();
    const { resolveExact } = mountChain({
      libraryMatches: [{ path: SUBSONIC_COPY_PATH, format: "mp3" }],
    });
    await resolveExact();
    expect(fallBackFromFailedSource(QBT_TRACK.key)).toBe(false);
    clearAllNativeRetries();
  });

  it("doesn't reuse a cached answer that came from a fallback", async () => {
    const { resolve, resolveExact, resolveStreamByUri } = mountChain({
      libraryMatches: [{ path: `file://${STALE_LIBRARY_PATH}`, format: "mp3" }],
      fileOnDisk: true,
      uriFails: true,
    });
    const full = await resolve();
    expect(full.engineSource).toEqual({ kind: "file", path: STALE_LIBRARY_PATH });
    await expect(resolveExact()).rejects.toThrow(/Couldn't find a playable source/);
    expect(resolveStreamByUri).toHaveBeenCalledTimes(2);
  });

  it("a track with no source of its own still walks the chain — there is no file to restrict to", async () => {
    const { resolveExact } = mountChain({
      pathless: true,
      libraryMatches: [{ path: `file://${STALE_LIBRARY_PATH}`, format: "mp3" }],
      fileOnDisk: true,
    });
    const out = await resolveExact();
    expect(out.engineSource).toEqual({ kind: "file", path: STALE_LIBRARY_PATH });
  });
});

describe("prefer video: the library's own video copy joins the video-first pass", () => {
  const LOCAL_VIDEO_PATH = "/music/Pearl Jam - Nothingman (Live).mkv";

  it("plays the user's own video copy before the track's own (audio) source", async () => {
    const { resolve, resolveStreamByUri } = mountChain({
      preferVideo: true,
      libraryMatches: [
        { path: "file:///music/Nothingman.mp3", format: "mp3" },
        { path: `file://${LOCAL_VIDEO_PATH}`, format: "mkv" },
      ],
      fileOnDisk: true,
    });

    const out = await resolve();

    // The video-first Library entry wins outright — the qbt source is never asked.
    expect(resolveStreamByUri).not.toHaveBeenCalled();
    expect(out.engineSource).toEqual({ kind: "file", path: LOCAL_VIDEO_PATH });
    // Reclassified from the copy that plays: real container, not the pass's
    // provisional "mp4" — and the path rides along for currentTrack enrichment.
    expect(out.patch).toEqual({ path: `file://${LOCAL_VIDEO_PATH}`, format: "mkv" });
  });

  it("falls through to the track's own audio source when no video copy exists", async () => {
    const { resolve, resolveStreamByUri, notify } = mountChain({
      preferVideo: true,
      libraryMatches: [{ path: "file:///music/Nothingman.mp3", format: "mp3" }],
      fileOnDisk: true,
    });

    const out = await resolve();

    expect(resolveStreamByUri).toHaveBeenCalled();
    expect(out.engineSource).toEqual({ kind: "file", path: "D:/Torrents/Vitalogy/05. Nothingman.mp3" });
    // The silent audio playback must not read as "prefer video did nothing".
    expect(notify).toHaveBeenCalledWith("No video found — playing audio.", { kind: "warning" });
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

describe("attributing a metadata resolver's file:// answer", () => {
  it("reports the file as the source, not the asset URL convertFileSrc made of it", async () => {
    // A plugin playback fallback (Soulseek) answers by metadata with a local
    // file and no sourceUrl. The source panel read the played src instead and
    // showed "host: asset.localhost" with no path and no Open folder.
    const soulseek: StreamResolver = {
      id: "slskd-fallback",
      name: "Soulseek",
      source: "slskd",
      resolve: vi.fn().mockResolvedValue({ url: "file://D:/slskd/viboplr/fallback/1-x/All Wrong.mp3" }),
    };
    const { resolve, result } = mountChain({ pathless: true, extraResolvers: [soulseek] });

    const out = await resolve();

    expect(out.engineSource).toEqual({ kind: "file", path: "D:/slskd/viboplr/fallback/1-x/All Wrong.mp3" });
    await vi.waitFor(() => expect(result.current.resolvedSource?.name).toBe("Soulseek"));
    expect(result.current.resolvedSource?.sourceUrl).toBe("file://D:/slskd/viboplr/fallback/1-x/All Wrong.mp3");
  });
});

describe("the failure record says which attempts were plugin fallbacks", () => {
  it("marks the plugin fallback, not the track's own source or the Library lookup", async () => {
    // The failure dialog's plugin suggestions read `fallback` to tell "no
    // playback fallback is on" from "the ones you have didn't find it".
    const soulseek: StreamResolver = {
      id: "slskd-fallback",
      name: "Soulseek",
      source: "slskd",
      resolve: vi.fn().mockResolvedValue(null),
    };
    const { resolve, result } = mountChain({ uriFails: true, extraResolvers: [soulseek] });

    await expect(resolve()).rejects.toThrow(/Couldn't find a playable source/);
    await vi.waitFor(() => expect(result.current.trackFailures[QBT_TRACK.key]).toBeTruthy());
    const attempts = result.current.trackFailures[QBT_TRACK.key].attempts;
    expect(attempts.map((a) => [a.name, a.fallback === true])).toEqual([
      ["qBittorrent", false],
      ["Library", false],
      ["Soulseek", true],
    ]);
  });

  it("a miss on the Prefer video pass isn't a fallback miss", async () => {
    // That pass asked only for a video; only the audio pass's attempt says
    // whether the plugin could find the song at all.
    const soulseek: StreamResolver = {
      id: "slskd-fallback",
      name: "Soulseek",
      source: "slskd",
      resolve: vi.fn().mockResolvedValue(null),
    };
    const { resolve, result } = mountChain({ uriFails: true, preferVideo: true, extraResolvers: [soulseek] });

    await expect(resolve()).rejects.toThrow(/Couldn't find a playable source/);
    await vi.waitFor(() => expect(result.current.trackFailures[QBT_TRACK.key]).toBeTruthy());
    const soulseekAttempts = result.current.trackFailures[QBT_TRACK.key].attempts.filter((a) => a.name === "Soulseek");
    expect(soulseekAttempts.map((a) => [a.outcome, a.fallback === true])).toEqual([
      ["no-video", false],
      ["miss", true],
    ]);
  });
});

describe("the queue row's source note (\"via X\")", () => {
  const soulseekFinds = (): StreamResolver => ({
    id: "slskd-fallback",
    name: "Soulseek",
    source: "slskd",
    resolve: vi.fn().mockResolvedValue({ url: "file://D:/slskd/fallback/Nothingman.mp3" }),
  });

  it("writes no note when the track played from its own source", async () => {
    const { resolve, result } = mountChain({ extraResolvers: [soulseekFinds()] });
    await resolve();
    await vi.waitFor(() => expect(result.current.resolvedSource?.name).toBe("qBittorrent"));
    expect(result.current.sourceNotes[QBT_TRACK.key]).toBeUndefined();
  });

  it("marks a fallback when the track's own source failed, with the walk that found it", async () => {
    const { resolve, result } = mountChain({ uriFails: true, extraResolvers: [soulseekFinds()] });
    await resolve();
    await vi.waitFor(() => expect(result.current.sourceNotes[QBT_TRACK.key]).toBeTruthy());
    const note = result.current.sourceNotes[QBT_TRACK.key];
    expect(note.name).toBe("Soulseek");
    expect(note.reason).toBe("fallback");
    expect(note.sourceUrl).toBe("file://D:/slskd/fallback/Nothingman.mp3");
    expect(note.attempts.map((a) => [a.name, a.outcome])).toEqual([
      ["qBittorrent", "error"],
      ["Library", "miss"],
      ["Soulseek", "found"],
    ]);
  });

  it("gives a metadata-only entry a neutral note: it has no source of its own", async () => {
    const { resolve, result } = mountChain({ pathless: true, extraResolvers: [soulseekFinds()] });
    await resolve();
    await vi.waitFor(() => expect(result.current.sourceNotes[QBT_TRACK.key]).toBeTruthy());
    expect(result.current.sourceNotes[QBT_TRACK.key].reason).toBe("no-source");
  });

  it("calls a Prefer video win what it is, not a fallback", async () => {
    const ytdlp: StreamResolver = {
      id: "ytdlp",
      name: "yt-dlp",
      source: "ytdlp",
      resolve: vi.fn().mockResolvedValue({ url: "file://D:/videos/Nothingman.mp4", video: true }),
    };
    const { resolve, result } = mountChain({ preferVideo: true, extraResolvers: [ytdlp] });
    await resolve();
    await vi.waitFor(() => expect(result.current.sourceNotes[QBT_TRACK.key]).toBeTruthy());
    expect(result.current.sourceNotes[QBT_TRACK.key]).toMatchObject({ name: "yt-dlp", reason: "prefer-video" });
  });

  it("lists a source the engine already gave up on as unplayable", async () => {
    clearAllNativeRetries();
    const { resolve, result } = mountChain({ extraResolvers: [soulseekFinds()] });
    await resolve();
    expect(fallBackFromFailedSource(QBT_TRACK.key)).toBe(true);
    await resolve();
    await vi.waitFor(() => expect(result.current.sourceNotes[QBT_TRACK.key]?.attempts[0]?.outcome).toBe("unplayable"));
    expect(result.current.sourceNotes[QBT_TRACK.key].reason).toBe("fallback");
    clearAllNativeRetries();
  });

  it("marks only the source that wouldn't play; earlier entries keep what they did", async () => {
    clearAllNativeRetries();
    const ytdlp: StreamResolver = {
      id: "ytdlp",
      name: "yt-dlp",
      source: "ytdlp",
      resolve: vi.fn().mockResolvedValue({ url: "file://D:/ytdlp/Nothingman.m4a" }),
    };
    const { resolve, result } = mountChain({ uriFails: true, extraResolvers: [soulseekFinds(), ytdlp] });
    await resolve();
    await vi.waitFor(() => expect(result.current.sourceNotes[QBT_TRACK.key]?.name).toBe("Soulseek"));
    // The engine couldn't open Soulseek's file: the next walk starts after it.
    expect(fallBackFromFailedSource(QBT_TRACK.key)).toBe(true);
    await resolve();
    await vi.waitFor(() => expect(result.current.sourceNotes[QBT_TRACK.key]?.name).toBe("yt-dlp"));
    expect(result.current.sourceNotes[QBT_TRACK.key].attempts.map((a) => [a.name, a.outcome])).toEqual([
      ["qBittorrent", "error"],
      ["Library", "miss"],
      ["Soulseek", "unplayable"],
      ["yt-dlp", "found"],
    ]);
    clearAllNativeRetries();
  });

  it("drops the note when a later walk finds nothing", async () => {
    clearAllNativeRetries();
    const ytdlpMisses: StreamResolver = { id: "ytdlp", name: "yt-dlp", source: "ytdlp", resolve: vi.fn().mockResolvedValue(null) };
    const { resolve, result } = mountChain({ uriFails: true, extraResolvers: [soulseekFinds(), ytdlpMisses] });
    await resolve();
    await vi.waitFor(() => expect(result.current.sourceNotes[QBT_TRACK.key]).toBeTruthy());
    expect(fallBackFromFailedSource(QBT_TRACK.key)).toBe(true);
    await expect(resolve()).rejects.toThrow(/Couldn't find a playable source/);
    await vi.waitFor(() => expect(result.current.sourceNotes[QBT_TRACK.key]).toBeUndefined());
    expect(result.current.resolvingByKey[QBT_TRACK.key]).toBeUndefined();
    clearAllNativeRetries();
  });
});

describe("skippedAttempt", () => {
  const previous = [
    { name: "qBittorrent", outcome: "error" as const, detail: "gone" },
    { name: "Library", outcome: "miss" as const },
    { name: "Soulseek", outcome: "found" as const },
  ];

  it("only the last skipped entry is the one that wouldn't play", () => {
    expect(skippedAttempt("Soulseek", 2, 3, previous)).toEqual({ name: "Soulseek", outcome: "unplayable" });
    expect(skippedAttempt("qBittorrent", 0, 3, previous)).toEqual(previous[0]);
    expect(skippedAttempt("Library", 1, 3, previous)).toEqual(previous[1]);
  });

  it("leaves out an entry it has no record for instead of guessing", () => {
    expect(skippedAttempt("yt-dlp", 0, 3, previous)).toBeNull();
    expect(skippedAttempt("Library", 1, 3, [])).toBeNull();
  });
});
