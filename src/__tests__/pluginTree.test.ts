import { describe, it, expect } from "vitest";
import { effectiveSelectedId, entitiesNeedingArt, entityPrimeSignature, expandedSignature, flattenTree, lazyExpandRequests, nodeKey, relocateCursor, rowKey, treeKey, type TreeRow } from "../utils/pluginTree";
import type { PluginTreeNode } from "../types/plugin";
import { widgetHandledKey } from "../utils/textEntry";

// Artist › Album, with one artist loaded, one lazy, one leaf-only.
const TREE: PluginTreeNode[] = [
  { id: "a1", label: "Massive Attack", children: [
    { id: "al1", label: "Mezzanine" },
    { id: "al2", label: "Protection" },
  ] },
  { id: "a2", label: "Portishead", hasChildren: true },
  { id: "a3", label: "Tricky" },
];

// Node rows by plugin id, the placeholder as "loading:<parent>".
const label = (r: TreeRow) => (r.kind === "node" ? r.node.id : `loading:${r.parentId}`);
const ids = (expanded: string[]) => flattenTree(TREE, new Set(expanded)).map(label);

describe("flattenTree", () => {
  it("shows only roots when nothing is expanded", () => {
    expect(ids([])).toEqual(["a1", "a2", "a3"]);
  });

  it("shows loaded children under an expanded node, with depth and parent", () => {
    const rows = flattenTree(TREE, new Set(["a1"]));
    expect(rows.map(label)).toEqual(["a1", "al1", "al2", "a2", "a3"]);
    const child = rows[1];
    expect(child.depth).toBe(1);
    expect(child.parentId).toBe("a1");
  });

  it("puts a loading row under an expanded lazy node", () => {
    const rows = flattenTree(TREE, new Set(["a2"]));
    expect(rows.map((r) => r.kind)).toEqual(["node", "node", "loading", "node"]);
    expect(rows[2].parentId).toBe("a2");
  });

  it("opens a loaded-but-empty node onto nothing (no loading row)", () => {
    const rows = flattenTree([{ id: "x", label: "X", hasChildren: true, children: [] }], new Set(["x"]));
    expect(rows.map(label)).toEqual(["x"]);
  });

  it("ignores an expanded id on a leaf", () => {
    expect(ids(["a3"])).toEqual(["a1", "a2", "a3"]);
  });
});

describe("treeKey (WAI-ARIA tree pattern)", () => {
  const open = flattenTree(TREE, new Set(["a1"])); // a1, al1, al2, a2, a3

  it("steps with ↑/↓ and clamps at the ends", () => {
    expect(treeKey(open, 0, "ArrowDown")).toEqual({ type: "move", index: 1 });
    expect(treeKey(open, 4, "ArrowDown")).toEqual({ type: "move", index: 4 });
    expect(treeKey(open, 0, "ArrowUp")).toEqual({ type: "move", index: 0 });
  });

  it("puts a cursor-less tree on the first row", () => {
    expect(treeKey(open, -1, "ArrowDown")).toEqual({ type: "move", index: 0 });
    expect(treeKey(open, -1, "ArrowUp")).toEqual({ type: "move", index: 0 });
    expect(treeKey(open, -1, "End")).toEqual({ type: "move", index: 4 });
  });

  it("with no cursor row, →/←/Enter/Space do nothing — never act on row 0", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "Enter", " "]) {
      expect(treeKey(open, -1, key)).toEqual({ type: "none" });
      expect(treeKey(open, 99, key)).toEqual({ type: "none" });
    }
  });

  it("jumps with Home / End", () => {
    expect(treeKey(open, 2, "Home")).toEqual({ type: "move", index: 0 });
    expect(treeKey(open, 0, "End")).toEqual({ type: "move", index: 4 });
  });

  it("→ expands a closed node, then steps into its first child", () => {
    expect(treeKey(open, 3, "ArrowRight")).toEqual({ type: "expand", id: "a2" });
    expect(treeKey(open, 0, "ArrowRight")).toEqual({ type: "move", index: 1 });
  });

  it("→ steps onto a lazy node's loading row", () => {
    const lazy = flattenTree(TREE, new Set(["a2"])); // a1, a2, loading, a3
    expect(treeKey(lazy, 1, "ArrowRight")).toEqual({ type: "move", index: 2 });
  });

  it("→ on a leaf stays put", () => {
    expect(treeKey(open, 1, "ArrowRight")).toEqual({ type: "move", index: 1 });
  });

  it("← collapses an open node, else steps out to the parent", () => {
    expect(treeKey(open, 0, "ArrowLeft")).toEqual({ type: "collapse", id: "a1" });
    expect(treeKey(open, 2, "ArrowLeft")).toEqual({ type: "move", index: 0 });
    expect(treeKey(open, 4, "ArrowLeft")).toEqual({ type: "move", index: 4 });
  });

  it("Enter / Space select a node, never the loading row", () => {
    expect(treeKey(open, 1, "Enter")).toEqual({ type: "select", id: "al1" });
    expect(treeKey(open, 1, " ")).toEqual({ type: "select", id: "al1" });
    const lazy = flattenTree(TREE, new Set(["a2"]));
    expect(treeKey(lazy, 2, "Enter")).toEqual({ type: "none" });
  });

  it("lets other keys through", () => {
    expect(treeKey(open, 0, "a")).toEqual({ type: "none" });
    expect(treeKey([], 0, "ArrowDown")).toEqual({ type: "none" });
  });
});

describe("expandedSignature", () => {
  it("is equal for equal lists, so a re-sent prop doesn't reset expansion", () => {
    expect(expandedSignature(["a", "b"])).toBe(expandedSignature(["a", "b"]));
    expect(expandedSignature(["a", "b"])).not.toBe(expandedSignature(["ab"]));
    expect(expandedSignature(undefined)).toBe("");
  });
});

describe("effectiveSelectedId (optimistic selection)", () => {
  it("shows the clicked node until the plugin answers", () => {
    expect(effectiveSelectedId("a", { id: "b", base: "a" })).toBe("b");
    expect(effectiveSelectedId(undefined, { id: "b", base: undefined })).toBe("b");
  });

  it("gives way the moment the plugin's selectedId moves, to whatever it chose", () => {
    expect(effectiveSelectedId("b", { id: "b", base: "a" })).toBe("b");
    expect(effectiveSelectedId("c", { id: "b", base: "a" })).toBe("c");
    expect(effectiveSelectedId("a", null)).toBe("a");
  });
});

describe("entityPrimeSignature", () => {
  it("is equal for equal entities in fresh node objects, and moves when the set does", () => {
    const one = flattenTree([{ id: "x", label: "X", entity: { kind: "artist", name: "X" } }], new Set());
    const same = flattenTree([{ id: "x", label: "X (2)", entity: { kind: "artist", name: "X" } }], new Set());
    const other = flattenTree([{ id: "x", label: "X", entity: { kind: "artist", name: "Y" } }], new Set());
    expect(entityPrimeSignature(one)).toBe(entityPrimeSignature(same));
    expect(entityPrimeSignature(one)).not.toBe(entityPrimeSignature(other));
  });

  it("leaves out nodes with their own image or no entity", () => {
    const rows = flattenTree([{ id: "x", label: "X", imageUrl: "https://a/b.jpg", entity: { kind: "artist", name: "X" } }, { id: "y", label: "Y" }], new Set());
    expect(entityPrimeSignature(rows)).toBe("");
  });
});

describe("rowKey", () => {
  it("can't collide a node with a loading row, whatever the plugin's ids", () => {
    // A node whose id looks like the old "<id>::loading" placeholder.
    const tricky: PluginTreeNode[] = [
      { id: "x", label: "X", hasChildren: true },
      { id: "x::loading", label: "Sneaky" },
    ];
    const keys = flattenTree(tricky, new Set(["x"])).map(rowKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe(nodeKey("x"));
  });
});

describe("entitiesNeedingArt", () => {
  it("lists each entity once, however many rows show it", () => {
    const rows = flattenTree([
      { id: "a", label: "A", entity: { kind: "artist", name: "MA" } },
      { id: "b", label: "B", entity: { kind: "artist", name: "MA" } },
      { id: "c", label: "C", entity: { kind: "album", name: "Mezzanine", artistName: "MA" } },
    ], new Set());
    expect(entitiesNeedingArt(rows).map((e) => e.name)).toEqual(["MA", "Mezzanine"]);
  });
});

describe("relocateCursor", () => {
  const open = new Set(["a1", "a2"]);
  const lazyOpen = flattenTree(TREE, open); // a1, al1, al2, a2, loading(a2), …

  it("keeps a key that is still drawn, and null", () => {
    expect(relocateCursor(lazyOpen, lazyOpen, nodeKey("al2"))).toBe(nodeKey("al2"));
    expect(relocateCursor(lazyOpen, lazyOpen, null)).toBeNull();
  });

  it("moves a loading row's cursor onto the first child that replaced it", () => {
    const loaded = TREE.map((n) => (n.id === "a2" ? { ...n, children: [{ id: "x1", label: "Dummy" }, { id: "x2", label: "Third" }] } : n));
    expect(relocateCursor(lazyOpen, flattenTree(loaded, open), "l:a2")).toBe(nodeKey("x1"));
  });

  it("moves a loading row's cursor onto its node when it opened onto nothing", () => {
    const empty = TREE.map((n) => (n.id === "a2" ? { ...n, children: [] } : n));
    expect(relocateCursor(lazyOpen, flattenTree(empty, open), "l:a2")).toBe(nodeKey("a2"));
  });

  it("moves a vanished node's cursor to its nearest surviving ancestor", () => {
    const collapsed = flattenTree(TREE, new Set(["a2"]));
    expect(relocateCursor(lazyOpen, collapsed, nodeKey("al2"))).toBe(nodeKey("a1"));
  });

  it("keeps the position of a vanished top-level row, clamped; null on an empty tree", () => {
    const prev = flattenTree(TREE, new Set());
    const at = prev.findIndex((r) => rowKey(r) === nodeKey("a2"));
    const without = flattenTree(TREE.filter((n) => n.id !== "a2"), new Set());
    expect(relocateCursor(prev, without, nodeKey("a2"))).toBe(rowKey(without[Math.min(at, without.length - 1)]));
    expect(relocateCursor(prev, [], nodeKey("a2"))).toBeNull();
  });

  it("forgets a key it never saw", () => {
    expect(relocateCursor(lazyOpen, lazyOpen, nodeKey("nope"))).toBeNull();
  });
});

describe("lazyExpandRequests", () => {
  it("asks for every lazy node waiting on a loading row that wasn't asked yet", () => {
    const rows = flattenTree(TREE, new Set(["a2"]));
    expect(lazyExpandRequests(rows, new Set()).request).toEqual(["a2"]);
    expect(lazyExpandRequests(rows, new Set(["a2"])).request).toEqual([]);
  });

  it("forgets a node once its loading row is gone, so a later wait asks again", () => {
    const { asked } = lazyExpandRequests(flattenTree(TREE, new Set()), new Set(["a2"]));
    expect(asked.has("a2")).toBe(false);
  });
});

describe("widgetHandledKey", () => {
  it("skips a navigation key a widget already handled", () => {
    for (const key of [" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
      expect(widgetHandledKey({ key, defaultPrevented: true })).toBe(true);
    }
  });

  it("lets a key the widget ignored through, and never claims other keys", () => {
    expect(widgetHandledKey({ key: " ", defaultPrevented: false })).toBe(false);
    expect(widgetHandledKey({ key: "ArrowUp", defaultPrevented: false })).toBe(false);
    expect(widgetHandledKey({ key: "m", defaultPrevented: true })).toBe(false);
  });
});
