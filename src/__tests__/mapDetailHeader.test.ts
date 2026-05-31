import { describe, it, expect, vi } from "vitest";
import { mapDetailHeaderToHeroProps } from "../components/pluginViews/mapDetailHeader";

// resolveImageUrl calls Tauri's convertFileSrc for local paths; stub it so the
// test runs without the Tauri runtime and we can assert pass-through for http.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

type HeaderNode = Extract<
  import("../types/plugin").PluginViewData,
  { type: "detail-header" }
>;

function node(overrides: Partial<HeaderNode> = {}): HeaderNode {
  return { type: "detail-header", title: "My Playlist", ...overrides };
}

describe("mapDetailHeaderToHeroProps", () => {
  it("maps title directly and defaults artShape to square", () => {
    const r = mapDetailHeaderToHeroProps(node(), undefined);
    expect(r.title).toBe("My Playlist");
    expect(r.artShape).toBe("square");
  });

  it("honors an explicit circle artShape", () => {
    const r = mapDetailHeaderToHeroProps(node({ artShape: "circle" }), undefined);
    expect(r.artShape).toBe("circle");
  });

  it("builds meta chips from subtitle then meta, skipping empties", () => {
    const r = mapDetailHeaderToHeroProps(
      node({ subtitle: "42 tracks", meta: "Updated today" }),
      undefined,
    );
    expect(r.meta).toEqual([{ label: "42 tracks" }, { label: "Updated today" }]);
  });

  it("omits absent subtitle/meta from chips", () => {
    const r = mapDetailHeaderToHeroProps(node({ meta: "only meta" }), undefined);
    expect(r.meta).toEqual([{ label: "only meta" }]);
  });

  it("resolves http bgImages unchanged and passes them through", () => {
    const r = mapDetailHeaderToHeroProps(
      node({ bgImages: ["https://x/a.jpg", "https://x/b.jpg"] }),
      undefined,
    );
    expect(r.bgImages).toEqual(["https://x/a.jpg", "https://x/b.jpg"]);
  });

  it("defaults bgImages to an empty array when absent", () => {
    const r = mapDetailHeaderToHeroProps(node(), undefined);
    expect(r.bgImages).toEqual([]);
  });

  it("wires play/enqueue/back callbacks to onAction with the right ids", () => {
    const onAction = vi.fn();
    const r = mapDetailHeaderToHeroProps(
      node({ playAction: "play", enqueueAction: "enq", backAction: "back" }),
      onAction,
    );
    r.onPlay!();
    r.onEnqueue!();
    r.onBack!();
    expect(onAction).toHaveBeenNthCalledWith(1, "play");
    expect(onAction).toHaveBeenNthCalledWith(2, "enq");
    expect(onAction).toHaveBeenNthCalledWith(3, "back");
  });

  it("leaves play/enqueue/back undefined when their action ids are absent", () => {
    const r = mapDetailHeaderToHeroProps(node(), vi.fn());
    expect(r.onPlay).toBeUndefined();
    expect(r.onEnqueue).toBeUndefined();
    expect(r.onBack).toBeUndefined();
  });

  it("maps actions then a divider then contextMenuActions into overflowItems", () => {
    const onAction = vi.fn();
    const r = mapDetailHeaderToHeroProps(
      node({
        actions: [{ id: "shuffle", label: "Shuffle" }],
        contextMenuActions: [
          { id: "del", label: "Delete" },
          { id: "sep", label: "", separator: true },
          { id: "info", label: "Info" },
        ],
      }),
      onAction,
    );
    expect(r.overflowItems.map((i) => i.kind)).toEqual([
      "action",
      "divider",
      "action",
      "divider",
      "action",
    ]);
    const first = r.overflowItems[0];
    if (first.kind === "action") first.onClick();
    expect(onAction).toHaveBeenCalledWith("shuffle");
  });

  it("emits no leading divider when actions is empty", () => {
    const r = mapDetailHeaderToHeroProps(
      node({ contextMenuActions: [{ id: "del", label: "Delete" }] }),
      vi.fn(),
    );
    expect(r.overflowItems.map((i) => i.kind)).toEqual(["action"]);
  });
});
