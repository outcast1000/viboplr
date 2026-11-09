import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";
import { PluginViewRenderer } from "../components/PluginViewRenderer";
import type { PluginViewData, PluginTreeNode } from "../types/plugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  convertFileSrc: (p: string) => p,
}));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: () => () => {},
  safeUnlisten: () => {},
  combineUnlisten: () => () => {},
}));

afterEach(cleanup);
Element.prototype.scrollIntoView = function () { /* jsdom has none */ };

const NODES: PluginTreeNode[] = [
  { id: "artist:1", label: "Massive Attack", hasChildren: true, entity: { kind: "artist", id: 1, name: "Massive Attack" }, data: { artistId: 1 } },
  { id: "artist:2", label: "Portishead", hasChildren: true },
];

function tree(extra: Partial<Extract<PluginViewData, { type: "tree" }>> = {}, onAction = vi.fn(), onEntityContextMenu = vi.fn()) {
  const data: PluginViewData = { type: "tree", nodes: NODES, selectAction: "select", expandAction: "expand", ...extra };
  const r = render(
    <PluginViewRenderer pluginName="Explorer" data={data} currentTrack={null} onAction={onAction} extras={{ onEntityContextMenu }} />,
  );
  return { ...r, onAction, onEntityContextMenu, tree: r.getByRole("tree") };
}

describe("tree view node", () => {
  it("claims only the keys it acts on, so the window's transport keys still get the rest", () => {
    const { tree: el } = tree();
    // No cursor row yet: Space / → / Enter do nothing here, so they stay free.
    expect(fireEvent.keyDown(el, { key: " " })).toBe(true);
    expect(fireEvent.keyDown(el, { key: "ArrowRight" })).toBe(true);
    // ↓ places the cursor: handled, so the window's volume shortcut stands down.
    expect(fireEvent.keyDown(el, { key: "ArrowDown" })).toBe(false);
    expect(fireEvent.keyDown(el, { key: "m" })).toBe(true);
  });

  it("drops the optimistic mark on the plugin's next answer, even one that ignored the click", () => {
    const onAction = vi.fn();
    const data = (n: number): PluginViewData => ({
      type: "tree", selectAction: "select", selectedId: "artist:2",
      nodes: NODES.map((x) => ({ ...x, sublabel: String(n) })),
    });
    const r = render(<PluginViewRenderer pluginName="Explorer" data={data(1)} currentTrack={null} onAction={onAction} />);
    fireEvent.click(r.getByText("Massive Attack"));
    expect(r.container.querySelector('[aria-selected="true"]')?.textContent).toContain("Massive Attack");
    // The plugin redraws with its selection unchanged (it doesn't select artists).
    r.rerender(<PluginViewRenderer pluginName="Explorer" data={data(2)} currentTrack={null} onAction={onAction} />);
    expect(r.container.querySelector('[aria-selected="true"]')?.textContent).toContain("Portishead");
  });

  it("a cursor whose row went away lands on its parent, not on the top of the tree", () => {
    const onAction = vi.fn();
    const withKids = (children: PluginTreeNode[]): PluginViewData => ({
      type: "tree", selectAction: "select", expandedIds: ["artist:1"],
      nodes: [{ ...NODES[0], children }, NODES[1]],
    });
    const r = render(<PluginViewRenderer pluginName="Explorer" data={withKids([{ id: "album:9", label: "Mezzanine" }])} currentTrack={null} onAction={onAction} />);
    const el = r.getByRole("tree");
    fireEvent.keyDown(el, { key: "ArrowDown" }); // Massive Attack
    fireEvent.keyDown(el, { key: "ArrowDown" }); // Mezzanine
    // The plugin redraws without the album: the cursor goes to its artist.
    r.rerender(<PluginViewRenderer pluginName="Explorer" data={withKids([])} currentTrack={null} onAction={onAction} />);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(onAction).toHaveBeenCalledWith("select", { id: "artist:1", data: { artistId: 1 } });
    // ...and ↓ continues from there.
    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "Enter" });
    expect(onAction).toHaveBeenLastCalledWith("select", { id: "artist:2", data: undefined });
  });

  it("a cursor on a loading row moves onto the first child when the children arrive", () => {
    const onAction = vi.fn();
    const data = (nodes: PluginTreeNode[]): PluginViewData => ({ type: "tree", nodes, selectAction: "select", expandAction: "expand" });
    const r = render(<PluginViewRenderer pluginName="Explorer" data={data(NODES)} currentTrack={null} onAction={onAction} />);
    const el = r.getByRole("tree");
    fireEvent.keyDown(el, { key: "ArrowDown" });  // Massive Attack
    fireEvent.keyDown(el, { key: "ArrowRight" }); // expand (lazy)
    fireEvent.keyDown(el, { key: "ArrowRight" }); // onto "Loading…"
    const loaded = [{ ...NODES[0], children: [{ id: "album:9", label: "Mezzanine" }, { id: "album:10", label: "Protection" }] }, NODES[1]];
    r.rerender(<PluginViewRenderer pluginName="Explorer" data={data(loaded)} currentTrack={null} onAction={onAction} />);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(onAction).toHaveBeenLastCalledWith("select", { id: "album:9", data: undefined });
  });

  it("asks the plugin for a lazy node that expandedIds opened, once per wait", () => {
    const onAction = vi.fn();
    const data = (nodes: PluginTreeNode[]): PluginViewData => ({ type: "tree", nodes, selectAction: "select", expandAction: "expand", expandedIds: ["artist:1"] });
    const r = render(<PluginViewRenderer pluginName="Explorer" data={data(NODES)} currentTrack={null} onAction={onAction} />);
    expect(r.getByText("Loading…")).toBeTruthy();
    expect(onAction).toHaveBeenCalledWith("expand", { id: "artist:1", expanded: true, data: { artistId: 1 } });
    // A redraw that still has no children doesn't ask again.
    r.rerender(<PluginViewRenderer pluginName="Explorer" data={data(NODES.map((n) => ({ ...n })))} currentTrack={null} onAction={onAction} />);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("a user's expand of a lazy node asks once, not again from the loading row it draws", () => {
    const { getByLabelText, onAction } = tree();
    fireEvent.click(getByLabelText("Expand Massive Attack"));
    expect(onAction.mock.calls.filter(([a]) => a === "expand")).toHaveLength(1);
  });

  it("selects on click, with the node's data", () => {
    const { getByText, onAction } = tree();
    fireEvent.click(getByText("Massive Attack"));
    expect(onAction).toHaveBeenCalledWith("select", { id: "artist:1", data: { artistId: 1 } });
  });

  it("expanding a lazy node fires the expand action and shows a loading row at once", () => {
    const { getByLabelText, getByText, onAction } = tree();
    fireEvent.click(getByLabelText("Expand Massive Attack"));
    expect(onAction).toHaveBeenCalledWith("expand", { id: "artist:1", expanded: true, data: { artistId: 1 } });
    expect(getByText("Loading…")).toBeTruthy();
    // The chevron click doesn't also select the row.
    expect(onAction).not.toHaveBeenCalledWith("select", expect.anything());
  });

  it("renders children once the plugin sends them, and keeps the node open", () => {
    const onAction = vi.fn();
    const data = (nodes: PluginTreeNode[]): PluginViewData => ({ type: "tree", nodes, selectAction: "select", expandAction: "expand" });
    const r = render(<PluginViewRenderer pluginName="Explorer" data={data(NODES)} currentTrack={null} onAction={onAction} />);
    fireEvent.click(r.getByLabelText("Expand Massive Attack"));
    const loaded = [{ ...NODES[0], children: [{ id: "album:9", label: "Mezzanine" }] }, NODES[1]];
    r.rerender(<PluginViewRenderer pluginName="Explorer" data={data(loaded)} currentTrack={null} onAction={onAction} />);
    expect(r.getByText("Mezzanine")).toBeTruthy();
    expect(r.queryByText("Loading…")).toBeNull();
  });

  it("drives the cursor and expansion from the keyboard", () => {
    const { tree: el, onAction } = tree();
    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(onAction).toHaveBeenCalledWith("expand", { id: "artist:1", expanded: true, data: { artistId: 1 } });
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(onAction).toHaveBeenCalledWith("expand", { id: "artist:1", expanded: false, data: { artistId: 1 } });
    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "Enter" });
    expect(onAction).toHaveBeenCalledWith("select", { id: "artist:2", data: undefined });
  });

  it("seeds expansion from expandedIds and marks the selected node", () => {
    const loaded: PluginTreeNode[] = [{ ...NODES[0], children: [{ id: "album:9", label: "Mezzanine" }] }];
    const { getByText, container } = tree({ nodes: loaded, expandedIds: ["artist:1"], selectedId: "album:9" });
    expect(getByText("Mezzanine")).toBeTruthy();
    const selected = container.querySelector('[aria-selected="true"]');
    expect(selected?.textContent).toContain("Mezzanine");
  });

  it("gives an entity node the host's menu, and a plain node none", () => {
    const { getByText, onEntityContextMenu } = tree();
    fireEvent.contextMenu(getByText("Massive Attack"));
    expect(onEntityContextMenu).toHaveBeenCalledWith(expect.anything(), { kind: "artist", id: 1, name: "Massive Attack" });
    fireEvent.contextMenu(getByText("Portishead"));
    expect(onEntityContextMenu).toHaveBeenCalledTimes(1);
  });

  it("marks a clicked node selected at once, before the plugin answers", () => {
    const { getByText, container } = tree({ selectedId: "artist:2" });
    fireEvent.click(getByText("Massive Attack"));
    const selected = container.querySelectorAll('[aria-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("Massive Attack");
  });

  it("follows the plugin's answer when it picks something else", () => {
    const onAction = vi.fn();
    const data = (selectedId?: string): PluginViewData => ({ type: "tree", nodes: NODES, selectAction: "select", selectedId });
    const r = render(<PluginViewRenderer pluginName="Explorer" data={data()} currentTrack={null} onAction={onAction} />);
    fireEvent.click(r.getByText("Massive Attack"));
    r.rerender(<PluginViewRenderer pluginName="Explorer" data={data("artist:2")} currentTrack={null} onAction={onAction} />);
    expect(r.container.querySelector('[aria-selected="true"]')?.textContent).toContain("Portishead");
  });

  it("a row that skipped a re-render still sends the plugin's latest data", () => {
    const onAction = vi.fn();
    const withData = (n: number): PluginViewData => ({
      type: "tree", selectAction: "select",
      nodes: [{ ...NODES[0], data: { artistId: 1, rev: n } }, NODES[1]],
    });
    const r = render(<PluginViewRenderer pluginName="Explorer" data={withData(1)} currentTrack={null} onAction={onAction} />);
    // Same label, sublabel, badge: the row's memo skips it; only `data` moved.
    r.rerender(<PluginViewRenderer pluginName="Explorer" data={withData(2)} currentTrack={null} onAction={onAction} />);
    fireEvent.click(r.getByText("Massive Attack"));
    expect(onAction).toHaveBeenCalledWith("select", { id: "artist:1", data: { artistId: 1, rev: 2 } });
  });

  it("shows the empty text for an empty tree", () => {
    const { getByText } = render(
      <PluginViewRenderer pluginName="Explorer" data={{ type: "tree", nodes: [], selectAction: "s", emptyText: "No artists" }} currentTrack={null} />,
    );
    expect(getByText("No artists")).toBeTruthy();
  });
});

describe("split view node", () => {
  const split = (persistKey?: string): PluginViewData => ({
    type: "split",
    persistKey,
    initialSize: 280,
    children: [{ type: "text", content: "left pane" }, { type: "text", content: "right pane" }],
  });

  it("fills the view and renders both panes", () => {
    const { container, getByText } = render(<PluginViewRenderer pluginName="Explorer" data={split()} currentTrack={null} />);
    expect(container.querySelector(".plugin-view--fill")).toBeTruthy();
    expect(getByText("left pane")).toBeTruthy();
    expect(getByText("right pane")).toBeTruthy();
    const first = container.querySelector(".psplit-pane--first") as HTMLElement;
    expect(first.style.width).toBe("280px");
  });

  it("uses the stored width and reports a keyboard resize under its persistKey", () => {
    const onSplitSizeChange = vi.fn();
    const { container, getByRole } = render(
      <PluginViewRenderer pluginName="Explorer" data={split("main")} currentTrack={null} extras={{ splitSizes: { main: 400 }, onSplitSizeChange }} />,
    );
    expect((container.querySelector(".psplit-pane--first") as HTMLElement).style.width).toBe("400px");
    fireEvent.keyDown(getByRole("separator"), { key: "ArrowLeft" });
    expect(onSplitSizeChange).toHaveBeenCalledWith("main", 384);
  });

  it("the divider takes only ←/→, leaving Space and ↑/↓ to the transport", () => {
    const { getByRole } = render(<PluginViewRenderer pluginName="Explorer" data={split("main")} currentTrack={null} />);
    const divider = getByRole("separator");
    expect(fireEvent.keyDown(divider, { key: "ArrowRight" })).toBe(false);
    expect(fireEvent.keyDown(divider, { key: " " })).toBe(true);
    expect(fireEvent.keyDown(divider, { key: "ArrowUp" })).toBe(true);
  });

  it("double-click resets by forgetting the stored width, back to initialSize", () => {
    const onSplitSizeReset = vi.fn();
    const { container, getByRole } = render(
      <PluginViewRenderer pluginName="Explorer" data={split("main")} currentTrack={null} extras={{ splitSizes: { main: 400 }, onSplitSizeReset }} />,
    );
    fireEvent.doubleClick(getByRole("separator"));
    expect(onSplitSizeReset).toHaveBeenCalledWith("main");
    expect((container.querySelector(".psplit-pane--first") as HTMLElement).style.width).toBe("280px");
  });

  it("an unmount mid-drag leaves no listener behind to commit a width", () => {
    const onSplitSizeChange = vi.fn();
    const r = render(
      <PluginViewRenderer pluginName="Explorer" data={split("main")} currentTrack={null} extras={{ onSplitSizeChange }} />,
    );
    const divider = r.getByRole("separator");
    fireEvent.pointerDown(divider, { button: 0, clientX: 280 });
    r.unmount();
    divider.dispatchEvent(new Event("pointerup"));
    expect(onSplitSizeChange).not.toHaveBeenCalled();
  });
});
