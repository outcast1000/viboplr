import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";
import { PluginViewRenderer } from "../components/PluginViewRenderer";
import type { PluginViewData } from "../types/plugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  convertFileSrc: (p: string) => p,
}));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: () => () => {},
  safeUnlisten: () => {},
  combineUnlisten: () => () => {},
}));

// Rendered through the RENDERER, for the same reason the selection-preset test
// is: a list-level field has to survive the trip from the node to the component,
// and that pass-through is where `selectionPresets` was silently lost once.
afterEach(cleanup);

// jsdom implements no layout, so it ships no scrollIntoView at all — and the
// list keeps its keyboard cursor on screen with one. Not an app concern.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const ITEMS = [
  { id: "aaa", title: "Some Artist - Album (1998) [FLAC]" },
  { id: "bbb", title: "Some.Movie.2021.1080p" },
  { id: "ccc", title: "Another Release" },
];

const ACTIONS = [
  { id: "qbt:play-torrent", label: "Play" },
  { id: "qbt:start", label: "Start" },
  { id: "qbt:stop", label: "Stop" },
  { id: "qbt:delete-ask", label: "Remove" },
];

function view(node: Partial<PluginViewData> = {}) {
  const data = {
    type: "track-row-list",
    selectable: true,
    items: ITEMS,
    actions: ACTIONS,
    ...node,
  } as PluginViewData;
  return render(
    <PluginViewRenderer pluginName="qBittorrent" data={data} currentTrack={null} />,
  );
}

const selectedRows = (c: HTMLElement) => c.querySelectorAll(".ptr-row-selected").length;

describe("track-row-list single selection", () => {
  it("drops the whole selection toolbar", () => {
    const { container, queryByText } = view({ selectionMode: "single" } as Partial<PluginViewData>);
    // All / None and the count build or describe a multi-selection...
    expect(queryByText("All")).toBeNull();
    expect(queryByText("None")).toBeNull();
    expect(queryByText("0 / 3")).toBeNull();
    // ...and the action buttons consume one. With one row current there is
    // nothing for any of them to act on, so the bar goes as a unit.
    expect(container.querySelector(".ptr-toolbar")).toBeNull();
  });

  it("keeps the per-row actions, which is where the work moved", () => {
    // Dropping the toolbar must not drop the actions themselves — the hover
    // tray is the only remaining way to start, stop or remove a row.
    const { container } = view({ selectionMode: "single" } as Partial<PluginViewData>);
    const tray = container.querySelectorAll(".ptr-row")[0].querySelectorAll(".row-hover-action");
    expect(tray.length).toBe(ACTIONS.length);
  });

  it("never selects a second row, whatever the modifiers", () => {
    const { container } = view({ selectionMode: "single" } as Partial<PluginViewData>);
    const rows = container.querySelectorAll(".ptr-row");
    fireEvent.click(rows[0]);
    expect(selectedRows(container)).toBe(1);
    fireEvent.click(rows[1], { metaKey: true });
    expect(selectedRows(container)).toBe(1);
    fireEvent.click(rows[2], { shiftKey: true });
    expect(selectedRows(container)).toBe(1);
    expect(container.querySelectorAll(".ptr-row")[2].classList.contains("ptr-row-selected")).toBe(true);
  });

  it("still lets a multi list build a selection", () => {
    // The default is unchanged, so every list that shipped before the field
    // behaves exactly as it did.
    const { container, getByText } = view();
    expect(getByText("All")).toBeTruthy();
    const rows = container.querySelectorAll(".ptr-row");
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1], { metaKey: true });
    expect(selectedRows(container)).toBe(2);
  });

  it("opens the row on a modifier click when it opens on click", () => {
    // A single-select container list has no multi-selection to preserve, so a
    // Cmd-click should not be a click that does nothing.
    const onAction = vi.fn();
    const data = {
      type: "track-row-list",
      selectable: true,
      selectionMode: "single",
      openOnClick: true,
      items: ITEMS,
      actions: ACTIONS,
    } as PluginViewData;
    const { container } = render(
      <PluginViewRenderer pluginName="qBittorrent" data={data} currentTrack={null} onAction={onAction} />,
    );
    fireEvent.click(container.querySelectorAll(".ptr-row")[1], { metaKey: true });
    expect(onAction).toHaveBeenCalledWith("qbt:play-torrent", { selectedIds: ["bbb"], itemId: "bbb" });
  });
});
