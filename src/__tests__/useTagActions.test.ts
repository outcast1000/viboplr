import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { applyTag, removeTag } from "../hooks/useTagActions";

describe("useTagActions invoke helpers", () => {
  beforeEach(() => invokeMock.mockReset());

  it("applyTag adds the single tag then re-reads the track's full tag list", async () => {
    // plugin_apply_tags is additive and returns only what it added; applyTag
    // must re-read get_tags_for_track so existing tags aren't dropped from the UI.
    invokeMock
      .mockResolvedValueOnce([[9, "grunge"]]) // plugin_apply_tags (the add)
      .mockResolvedValueOnce([{ id: 5, name: "rock" }, { id: 9, name: "grunge" }]); // get_tags_for_track
    const result = await applyTag(42, "grunge");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "plugin_apply_tags", { trackId: 42, tagNames: ["grunge"] });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_tags_for_track", { trackId: 42 });
    expect(result).toEqual(["rock", "grunge"]);
  });

  it("removeTag calls replace_track_tags with the remaining names", async () => {
    invokeMock.mockResolvedValue([[5, "rock"]]);
    const result = await removeTag(42, ["chill", "90s"], "90s");
    expect(invokeMock).toHaveBeenCalledWith("replace_track_tags", { trackId: 42, tagNames: ["chill"] });
    expect(result).toEqual(["rock"]);
  });

  it("removeTag is case-insensitive when filtering the removed name", async () => {
    invokeMock.mockResolvedValue([]);
    await removeTag(42, ["Rock", "Chill"], "rock");
    expect(invokeMock).toHaveBeenCalledWith("replace_track_tags", { trackId: 42, tagNames: ["Chill"] });
  });
});
