import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";
import { PluginViewRenderer } from "../components/PluginViewRenderer";
import type { PluginViewData } from "../types/plugin";
import type { RowMenuAction } from "../components/pluginViews/pluginViews";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  convertFileSrc: (p: string) => p,
}));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: () => () => {},
  safeUnlisten: () => {},
  combineUnlisten: () => () => {},
}));

// A track-row-list row's own hover actions reach the host's right-click menu
// (the third argument of onTrackRowContextMenu), so they are no longer
// reachable by hover alone.
afterEach(cleanup);
Element.prototype.scrollIntoView = function () {};

function view(onAction = vi.fn(), onMenu = vi.fn()) {
  const data = {
    type: "track-row-list",
    selectable: true,
    items: [
      { id: "a", title: "Teardrop", actions: ["download-file"] },
      { id: "b", title: "Angel", actions: ["download-file", "open-folder"] },
      { id: "c", title: "Inertia Creeps", actions: ["open-folder"] },
    ],
    actions: [
      { id: "download-file", label: "Download", icon: "⬇" },
      { id: "open-folder", label: "Open folder", icon: "📂" },
    ],
  } as PluginViewData;
  const r = render(
    <PluginViewRenderer pluginName="Soulseek" data={data} currentTrack={null} onAction={onAction} onTrackRowContextMenu={onMenu} />,
  );
  const rows = Array.from(r.container.querySelectorAll(".ptr-row")) as HTMLElement[];
  return { ...r, rows, onAction, onMenu };
}

describe("track-row-list right-click menu", () => {
  it("carries the right-clicked row's own actions, which run with the hover payload", () => {
    const { rows, onAction, onMenu } = view();
    fireEvent.contextMenu(rows[0]);
    const rowActions = onMenu.mock.calls[0][2] as RowMenuAction[];
    expect(rowActions.map((a) => a.label)).toEqual(["Download"]);
    rowActions[0].run();
    expect(onAction).toHaveBeenCalledWith("download-file", { selectedIds: ["a"], itemId: "a" });
  });

  it("for a selection, offers each action on the rows that show it", () => {
    const { rows, onAction, onMenu } = view();
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1], { metaKey: true });
    fireEvent.contextMenu(rows[1]);
    const rowActions = onMenu.mock.calls[0][2] as RowMenuAction[];
    expect(rowActions.map((a) => a.label)).toEqual(["Download (2)", "Open folder"]);
    rowActions[0].run();
    expect(onAction).toHaveBeenCalledWith("download-file", { selectedIds: ["a", "b"] });
  });
});
