// useTagActions is the in-app quick-edit path (the Now Playing bar's
// TagPopover). It now runs the shared tag ops, so what these pin is the part
// that used to be missing: an edit here reaches the TagOpsContext refresh (the
// tag recount + Library reload) the plugin API and control API get — before,
// a tag added from the popover stayed invisible in the Tags tab until the
// next scan. Plus the call shape TagPopover relies on: full list back, or null.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { useTagActions } from "../hooks/useTagActions";
import { TagOpsProvider } from "../contexts/TagOpsContext";
import type { TagOpsDeps } from "../utils/tagOps";

function setup() {
  const deps: TagOpsDeps = { tagsChanged: vi.fn(), filesWritten: vi.fn() };
  const wrapper = ({ children }: { children: ReactNode }) => <TagOpsProvider value={deps}>{children}</TagOpsProvider>;
  const { result } = renderHook(() => useTagActions(), { wrapper });
  return { deps, actions: result.current };
}

describe("useTagActions", () => {
  beforeEach(() => { invokeMock.mockReset(); });
  afterEach(cleanup);

  it("add applies the tag, returns the full re-read list, and refreshes the Library", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "get_tags_for_track" ? [{ id: 5, name: "rock" }, { id: 9, name: "grunge" }] : 1);
    const { deps, actions } = setup();
    await expect(actions.add(42, "grunge")).resolves.toEqual(["rock", "grunge"]);
    expect(invokeMock).toHaveBeenCalledWith("plugin_apply_tags_bulk", { assignments: [[42, ["grunge"]]] });
    expect(deps.tagsChanged).toHaveBeenCalledTimes(1);
  });

  it("remove goes through the accent-insensitive by-name path, not a tag-set replace", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "get_tags_for_track" ? [{ id: 5, name: "chill" }] : undefined);
    const { deps, actions } = setup();
    await expect(actions.remove(42, ["chill", "90s"], "90s")).resolves.toEqual(["chill"]);
    expect(invokeMock).toHaveBeenCalledWith("remove_tag_from_tracks", { trackIds: [42], tagName: "90s" });
    expect(invokeMock).not.toHaveBeenCalledWith("replace_track_tags", expect.anything());
    expect(deps.tagsChanged).toHaveBeenCalledTimes(1);
  });

  it("a failed write resolves null (the popover reverts its chip) and logs", async () => {
    invokeMock.mockRejectedValue(new Error("db locked"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, actions } = setup();
    await expect(actions.add(42, "x")).resolves.toBeNull();
    expect(err).toHaveBeenCalled();
    expect(deps.tagsChanged).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("works without a provider (no refresh wired)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "get_tags_for_track" ? [] : 1));
    const { result } = renderHook(() => useTagActions());
    await expect(result.current.add(1, "a")).resolves.toEqual([]);
  });
});
