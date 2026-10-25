// "Move to Trash" on a queue entry whose file is in no collection (dropped in
// from Finder, an m3u entry outside the library). `delete_tracks` is id-only,
// so these used to get "Those tracks aren't in your library" from a menu item
// that had just offered the delete. They now go to `trash_queue_files` by path,
// alongside the library half of a mixed selection, and leave the queue the same
// way a library delete does.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useContextMenuActions } from "../hooks/useContextMenuActions";
import type { QueueTrack } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("../telemetry", () => ({ track: vi.fn(), sourceClass: () => "local", bucketCount: () => "0" }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const inLibrary: QueueTrack = {
  key: "q:1", libraryId: 7, path: "file:///music/Kept.mp3", title: "Kept",
  artist_name: "A", album_title: null, duration_secs: 100, format: "mp3", liked: 0,
};
const loose: QueueTrack = {
  key: "q:2", path: "file:///Users/me/Downloads/Loose.flac", title: "Loose",
  artist_name: "B", album_title: null, duration_secs: 100, format: "flac", liked: 0,
};

function mount(queue: QueueTrack[], confirmTrashDelete = false) {
  const calls: string[] = [];
  const flushNow = vi.fn(async () => { calls.push("flush"); });
  const removeMultiple = vi.fn();
  const noop = vi.fn();
  const hook = renderHook(() => useContextMenuActions({
    library: {
      tracks: [], artists: [], albums: [],
      setTracks: noop, loadLibrary: vi.fn(async () => {}), loadTracks: vi.fn(async () => {}),
    },
    queueHook: {
      playTracks: noop, enqueueTracks: noop,
      findDuplicates: () => ({ duplicates: [], unique: [] }),
      insertAtPosition: noop, removeMultiple, moveToTop: noop, moveToBottom: noop,
      queue, addToQueue: noop, flushNow,
    },
    playback: { currentTrack: null, handleStop: noop },
    playActions: { playAlbum: noop, playArtist: noop, playTag: noop, startRadio: noop },
    queueCollapsed: false,
    setQueueCollapsed: noop,
    confirmTrashDelete,
  }));
  return { hook, calls, flushNow, removeMultiple };
}

function openQueueMenu(hook: ReturnType<typeof mount>["hook"], indices: number[]) {
  act(() => {
    hook.result.current.setContextMenu({
      x: 0, y: 0,
      target: {
        kind: "queue-multi", indices, trackIds: [],
        firstTrack: { title: "", artistName: null, albumTitle: null, isLocal: true },
      },
    });
  });
}

describe("deleting queue files that aren't in the library", () => {
  it("trashes the loose file by path and the library one by id", async () => {
    const { hook, calls, removeMultiple } = mount([inLibrary, loose]);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "find_track_ids_by_paths") return [];
      if (cmd === "delete_tracks") return { deletedIds: [7], deletedPaths: [inLibrary.path], failures: [] };
      if (cmd === "trash_queue_files") return { deletedIds: [], deletedPaths: [loose.path], failures: [] };
      return undefined;
    });
    openQueueMenu(hook, [0, 1]);

    await act(async () => { await hook.result.current.handleDeleteRequest(); });

    expect(invoke).toHaveBeenCalledWith("delete_tracks", { trackIds: [7] });
    expect(invoke).toHaveBeenCalledWith("trash_queue_files", { paths: [loose.path] });
    // The backend checks paths against the saved queue — flush it first.
    expect(calls.indexOf("flush")).toBeLessThan(calls.indexOf("trash_queue_files"));
    expect(removeMultiple).toHaveBeenCalledWith([0, 1]);
    expect(hook.result.current.deleteError).toBeNull();
  });

  it("asks first when confirmation is on, and the modal's request carries the path", async () => {
    const { hook } = mount([loose], true);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "find_track_ids_by_paths" ? [] : undefined));
    openQueueMenu(hook, [0]);

    await act(async () => { await hook.result.current.handleDeleteRequest(); });
    expect(hook.result.current.deleteConfirm).toMatchObject({ trackIds: [], paths: [loose.path], title: "Loose" });
    expect(invoke).not.toHaveBeenCalledWith("trash_queue_files", expect.anything());

    await act(async () => { await hook.result.current.handleDeleteConfirm(); });
    expect(invoke).toHaveBeenCalledWith("trash_queue_files", { paths: [loose.path] });
    expect(invoke).not.toHaveBeenCalledWith("delete_tracks", expect.anything());
  });

  it("reports a refused file instead of claiming success", async () => {
    const { hook, removeMultiple } = mount([loose]);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "find_track_ids_by_paths") return [];
      if (cmd === "trash_queue_files") return { deletedIds: [], deletedPaths: [], failures: [{ title: "Loose.flac", reason: "Not in the queue" }] };
      return undefined;
    });
    openQueueMenu(hook, [0]);

    await act(async () => { await hook.result.current.handleDeleteRequest(); });

    expect(removeMultiple).not.toHaveBeenCalled();
    expect(hook.result.current.deleteError?.failures).toEqual([{ title: "Loose.flac", reason: "Not in the queue" }]);
  });
});
