import { describe, it, expect } from "vitest";
import { toPluginTarget } from "../types/contextMenu";
import type { ContextMenuTarget } from "../types/contextMenu";

describe("toPluginTarget", () => {
  it("maps a single ID-less queue track to a track target with metadata", () => {
    // External/YouTube/restored tracks have ext:N keys, so parseLibraryId
    // filters them out and trackIds is empty even though one row is selected.
    // Regression: this used to fall through to a metadata-less multi-track
    // target, making metadata-only plugin actions (e.g. "Watch YouTube video")
    // a silent no-op.
    const target: ContextMenuTarget = {
      kind: "queue-multi",
      indices: [3],
      trackIds: [],
      firstTrack: { title: "Song", artistName: "Artist", albumTitle: "Album", isLocal: false },
    };
    expect(toPluginTarget(target)).toEqual({
      kind: "track",
      trackId: undefined,
      title: "Song",
      artistName: "Artist",
      albumTitle: "Album",
      isLocal: false,
    });
  });

  it("carries the library id for a single queue track that has one", () => {
    const target: ContextMenuTarget = {
      kind: "queue-multi",
      indices: [0],
      trackIds: [42],
      firstTrack: { title: "Song", artistName: "Artist", albumTitle: "Album", isLocal: true },
    };
    expect(toPluginTarget(target)).toEqual({
      kind: "track",
      trackId: 42,
      title: "Song",
      artistName: "Artist",
      albumTitle: "Album",
      isLocal: true,
    });
  });

  it("maps a multi-row queue selection to a multi-track target", () => {
    const target: ContextMenuTarget = {
      kind: "queue-multi",
      indices: [0, 1, 2],
      trackIds: [1, 2],
      firstTrack: { title: "Song", artistName: "Artist", albumTitle: null, isLocal: false },
    };
    expect(toPluginTarget(target)).toEqual({ kind: "multi-track", trackIds: [1, 2] });
  });

  it("normalizes null artistName/albumTitle to undefined", () => {
    const target: ContextMenuTarget = {
      kind: "queue-multi",
      indices: [1],
      trackIds: [],
      firstTrack: { title: "Song", artistName: null, albumTitle: null, isLocal: false },
    };
    expect(toPluginTarget(target)).toMatchObject({ kind: "track", artistName: undefined, albumTitle: undefined });
  });

  it("carries albumTitle on a plain track target", () => {
    // Regression: plugin actions build metadata queries (e.g. an
    // "artist album" torrent hunt) from albumTitle; the host used to drop
    // the album on every track-shaped target, so it was always empty.
    const target: ContextMenuTarget = {
      kind: "track",
      trackId: 7,
      isLocal: true,
      title: "Song",
      artistName: "Artist",
      albumTitle: "Album",
    };
    expect(toPluginTarget(target)).toEqual({
      kind: "track",
      trackId: 7,
      title: "Song",
      artistName: "Artist",
      albumTitle: "Album",
      isLocal: true,
    });
  });
});
