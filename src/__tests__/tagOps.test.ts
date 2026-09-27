// The shared tag operations behind the control API's tags.edit / tags.writeFiles
// and the plugin API's applyTags / applyTagsBulk / removeTags / bulkUpdateTracks.
// Pinned hardest: the tag-mode default (the backend reads a missing mode as
// REPLACE, which silently wiped every other tag when a plugin passed
// tag_names), that every write tells the app to refresh, and the
// presence-vs-null contract that decides whether a field is cleared.
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
const emitTrackPatch = vi.fn();
vi.mock("../trackEvents", () => ({ emitTrackPatch: (...args: unknown[]) => emitTrackPatch(...args) }));

import {
  addTags, buildFileMetadataFields, editTrackTags, removeTags, writeFileMetadata, type TagOpsDeps,
} from "../utils/tagOps";

function deps(): TagOpsDeps {
  return { tagsChanged: vi.fn(), filesWritten: vi.fn() };
}

beforeEach(() => {
  invokeMock.mockReset();
  emitTrackPatch.mockReset();
});

describe("addTags", () => {
  it("sends cleaned, de-duplicated names in one bulk call and signals a refresh", async () => {
    invokeMock.mockResolvedValue(2);
    const d = deps();
    const n = await addTags(d, [[1, [" Jazz ", "jazz", "", "Bebop"]], [2, ["Jazz"]], [3, []]]);
    expect(n).toBe(2);
    expect(invokeMock).toHaveBeenCalledWith("plugin_apply_tags_bulk", {
      assignments: [[1, ["Jazz", "Bebop"]], [2, ["Jazz"]]],
    });
    expect(d.tagsChanged).toHaveBeenCalledTimes(1);
  });

  it("nothing to add → no backend call, no refresh", async () => {
    const d = deps();
    expect(await addTags(d, [[1, []], [2, ["  "]]])).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(d.tagsChanged).not.toHaveBeenCalled();
  });
});

describe("removeTags", () => {
  it("removes each name through the diacritic-insensitive backend path", async () => {
    invokeMock.mockResolvedValue(undefined);
    const d = deps();
    await removeTags(d, [1, 2], ["Rock", "rock", "Pop"]);
    expect(invokeMock.mock.calls).toEqual([
      ["remove_tag_from_tracks", { trackIds: [1, 2], tagName: "Rock" }],
      ["remove_tag_from_tracks", { trackIds: [1, 2], tagName: "Pop" }],
    ]);
    expect(d.tagsChanged).toHaveBeenCalledTimes(1);
  });

  it("empty ids or names is a no-op", async () => {
    const d = deps();
    await removeTags(d, [], ["Rock"]);
    await removeTags(d, [1], []);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(d.tagsChanged).not.toHaveBeenCalled();
  });
});

describe("editTrackTags", () => {
  it("removes, then adds, then reads the full list back — one refresh", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "get_tags_for_track" ? [{ id: 7, name: "Jazz", track_count: 1 }] : 1);
    const d = deps();
    const tags = await editTrackTags(d, 5, { add: ["Jazz"], remove: ["Rock"] });
    expect(invokeMock.mock.calls.map((c) => c[0])).toEqual([
      "remove_tag_from_tracks", "plugin_apply_tags_bulk", "get_tags_for_track",
    ]);
    expect(tags).toEqual([{ id: 7, name: "Jazz" }]);
    expect(d.tagsChanged).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty edit", async () => {
    await expect(editTrackTags(deps(), 5, { add: [" "] })).rejects.toThrow("nothing to change");
  });
});

describe("buildFileMetadataFields", () => {
  it("tagNames without a mode ADDS — never the backend's replace default", () => {
    expect(buildFileMetadataFields([1], { tagNames: ["Jazz"] }))
      .toEqual({ tag_names: ["Jazz"], tag_mode: "add" });
  });

  it("only replace may clear tags", () => {
    expect(() => buildFileMetadataFields([1], { tagNames: [] })).toThrow("only tagMode=replace");
    expect(buildFileMetadataFields([1], { tagNames: [], tagMode: "replace" }))
      .toEqual({ tag_names: [], tag_mode: "replace" });
  });

  it("rejects an unknown mode, and a mode without names", () => {
    expect(() => buildFileMetadataFields([1], { tagNames: ["a"], tagMode: "merge" })).toThrow("tagMode must be");
    expect(() => buildFileMetadataFields([1], { tagMode: "add" })).toThrow("tagMode needs tagNames");
  });

  it("absent leaves a field alone; null and \"\" clear it", () => {
    expect(buildFileMetadataFields([1], { artistName: "", albumTitle: null, year: null }))
      .toEqual({ artist_name: null, album_title: null, year: null });
    expect(buildFileMetadataFields([1], { artistName: undefined, year: 1999 })).toEqual({ year: 1999 });
  });

  it("type-checks values, since both callers are untyped at runtime", () => {
    expect(() => buildFileMetadataFields([1], { artistName: 5 })).toThrow("artistName must be a string or null");
    expect(() => buildFileMetadataFields([1], { year: 1999.5 })).toThrow("year must be an integer or null");
    expect(() => buildFileMetadataFields([1], { tagNames: "Jazz" })).toThrow("tagNames must be an array");
  });

  it("title is single-track and non-empty", () => {
    expect(buildFileMetadataFields([1], { title: "Song" })).toEqual({ title: "Song" });
    expect(() => buildFileMetadataFields([1, 2], { title: "Song" })).toThrow("single track");
    expect(() => buildFileMetadataFields([1], { title: " " })).toThrow("non-empty");
    expect(() => buildFileMetadataFields([1], { title: null })).toThrow("non-empty");
  });

  it("refuses an empty edit and an empty id list", () => {
    expect(() => buildFileMetadataFields([1], {})).toThrow("nothing to write");
    expect(() => buildFileMetadataFields([], { year: 1 })).toThrow("non-empty array");
  });
});

describe("writeFileMetadata", () => {
  it("writes, patches open views on full success, and refreshes", async () => {
    invokeMock.mockResolvedValue([]);
    const d = deps();
    const errors = await writeFileMetadata(d, [1, 2], { artistName: "X", tagNames: ["Jazz"] });
    expect(errors).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("bulk_update_tracks", {
      trackIds: [1, 2],
      fields: { artist_name: "X", tag_names: ["Jazz"], tag_mode: "add" },
    });
    expect(emitTrackPatch.mock.calls).toEqual([[1, { artist_name: "X" }], [2, { artist_name: "X" }]]);
    expect(d.filesWritten).toHaveBeenCalledTimes(1);
  });

  it("a partial failure still refreshes but sends no live patch", async () => {
    invokeMock.mockResolvedValue(["track 2: read-only file"]);
    const d = deps();
    await expect(writeFileMetadata(d, [1, 2], { year: 2001 })).resolves.toEqual(["track 2: read-only file"]);
    expect(emitTrackPatch).not.toHaveBeenCalled();
    expect(d.filesWritten).toHaveBeenCalledTimes(1);
  });

  it("a tags-only write sends no patch (tags aren't Track fields)", async () => {
    invokeMock.mockResolvedValue([]);
    await writeFileMetadata(deps(), [1], { tagNames: ["Jazz"] });
    expect(emitTrackPatch).not.toHaveBeenCalled();
  });

  it("a validation failure touches nothing", async () => {
    const d = deps();
    await expect(writeFileMetadata(d, [1], {})).rejects.toThrow("nothing to write");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(d.filesWritten).not.toHaveBeenCalled();
  });
});
