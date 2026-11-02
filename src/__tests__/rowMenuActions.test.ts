import { describe, it, expect, vi } from "vitest";
import { hostItemsNotShadowed, rowMenuActions } from "../components/pluginViews/pluginViews";

/**
 * A plugin row's own actions (its hover buttons) in its right-click menu —
 * the same applicability and payload rules as the hover button for one row
 * and the selection toolbar for several.
 */

const declared = [
  { id: "download-file", label: "Download" },
  { id: "skip", label: "Skip" },
  { id: "open-folder", label: "Open folder" },
];

describe("rowMenuActions", () => {
  it("offers one row's actions with the hover button's payload", () => {
    const onAction = vi.fn();
    const out = rowMenuActions(declared, [{ id: "r1", actions: ["download-file", "open-folder"] }], onAction);
    expect(out.map((a) => a.label)).toEqual(["Download", "Open folder"]);
    out[0].run();
    expect(onAction).toHaveBeenCalledWith("download-file", { selectedIds: ["r1"], itemId: "r1" });
  });

  it("a row naming no subset offers every declared action, in declared order", () => {
    const out = rowMenuActions(declared, [{ id: "r1" }], vi.fn());
    expect(out.map((a) => a.id)).toEqual(["download-file", "skip", "open-folder"]);
  });

  it("for a selection, offers what any row shows and runs it on just those rows", () => {
    const onAction = vi.fn();
    const out = rowMenuActions(declared, [
      { id: "a", actions: ["download-file"] },
      { id: "b", actions: ["download-file", "skip"] },
      { id: "c", actions: ["skip"] },
    ], onAction);
    expect(out.map((a) => a.label)).toEqual(["Download (2)", "Skip (2)"]);
    out[1].run();
    expect(onAction).toHaveBeenCalledWith("skip", { selectedIds: ["b", "c"] });
  });

  it("a row action named like a host item replaces that item; the rest stay", () => {
    const onAction = vi.fn();
    const own = rowMenuActions(
      [{ id: "play-kept", label: " play " }, { id: "download-file", label: "Download" }],
      [{ id: "r1" }],
      onAction,
    );
    const host = [
      { kind: "item", text: "Play" },
      { kind: "item", text: "Enqueue" },
      { kind: "separator" },
      { kind: "item", text: "Play Next" },
    ];
    expect(hostItemsNotShadowed(host, own)).toEqual([
      { kind: "item", text: "Enqueue" },
      { kind: "separator" },
      { kind: "item", text: "Play Next" },
    ]);
    // The one Play left is the row's, and it runs the row's own handler.
    own[0].run();
    expect(onAction).toHaveBeenCalledWith("play-kept", { selectedIds: ["r1"], itemId: "r1" });
  });

  it("offers nothing without declared actions or a handler", () => {
    expect(rowMenuActions(undefined, [{ id: "r1" }], vi.fn())).toEqual([]);
    expect(rowMenuActions(declared, [{ id: "r1" }], undefined)).toEqual([]);
    expect(rowMenuActions(declared, [{ id: "r1", actions: [] }], vi.fn())).toEqual([]);
  });
});
