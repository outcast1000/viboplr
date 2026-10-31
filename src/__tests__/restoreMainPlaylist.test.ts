import { describe, it, expect, vi } from "vitest";
import { restoreMainPlaylist } from "../startup/restoreMainPlaylist";
import type { Manifest, ManifestTrack } from "../mainPlaylist";

function entry(overrides: Partial<ManifestTrack> = {}): ManifestTrack {
  return {
    title: "Song", artist: "Artist", album: "Album", duration_secs: 200,
    file: "file:///a.mp3", thumb: null, ...overrides,
  };
}

function manifest(tracks: ManifestTrack[]): Manifest {
  return { version: 1, title: "Queue", type: "custom", created_at: "2026-11-01T00:00:00Z", tracks } as Manifest;
}

function fakeInvoke(answers: Record<string, unknown>) {
  return vi.fn(async (cmd: string) => {
    if (!(cmd in answers)) throw new Error(`unexpected ${cmd}`);
    const a = answers[cmd];
    if (a instanceof Error) throw a;
    return a;
  }) as unknown as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

const noLikes = vi.fn(async () => new Map()) as never;

describe("restoreMainPlaylist", () => {
  it("returns nothing to apply when no queue was saved", async () => {
    const invoke = fakeInvoke({
      main_playlist_read: { manifest: null, state: null, thumbs: [] },
      main_playlist_dir: "/p",
    });
    const r = await restoreMainPlaylist(invoke, noLikes);
    expect(r).toEqual({ queue: null, thumbs: [], context: null, mode: null });
  });

  it("restores tracks, index, thumbs and mode, and re-resolves library ids by path", async () => {
    const invoke = fakeInvoke({
      main_playlist_read: {
        manifest: manifest([entry(), entry({ title: "Other", file: "file:///b.mp3" })]),
        state: { queueIndex: 1, queueMode: "repeat-one" },
        thumbs: [["file:///a.mp3", "a.jpg"]],
      },
      main_playlist_dir: "/p",
      find_track_ids_by_paths: [["file:///b.mp3", 42]],
    });
    const r = await restoreMainPlaylist(invoke, noLikes);
    expect(r.queue?.tracks.map(t => t.title)).toEqual(["Song", "Other"]);
    expect(r.queue?.index).toBe(1);
    expect(r.queue?.tracks[0].libraryId).toBeUndefined();
    expect(r.queue?.tracks[1].libraryId).toBe(42);
    expect(r.thumbs).toEqual([["file:///a.mp3", "a.jpg"]]);
    expect(r.mode).toBe("repeat-one");
  });

  it("drops an out-of-range index and an unknown mode", async () => {
    const invoke = fakeInvoke({
      main_playlist_read: { manifest: manifest([entry()]), state: { queueIndex: 5, queueMode: "shuffle" }, thumbs: [] },
      main_playlist_dir: "/p",
      find_track_ids_by_paths: [],
    });
    const r = await restoreMainPlaylist(invoke, noLikes);
    expect(r.queue?.index).toBe(-1);
    expect(r.mode).toBe("normal");
  });

  it("still restores the queue when the like and id lookups fail", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const invoke = fakeInvoke({
      main_playlist_read: { manifest: manifest([entry()]), state: { queueIndex: 0 }, thumbs: [] },
      main_playlist_dir: "/p",
      find_track_ids_by_paths: new Error("db busy"),
    });
    const failingLikes = vi.fn(async () => { throw new Error("no likes"); }) as never;
    const r = await restoreMainPlaylist(invoke, failingLikes);
    expect(r.queue?.tracks).toHaveLength(1);
    expect(r.queue?.index).toBe(0);
    expect(consoleError).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});
