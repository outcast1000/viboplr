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

// This renders through the RENDERER rather than asserting on the row list's
// props, because that is exactly where the bug was: `selectionPresets` had a
// toolbar implementation, a `presetIds` helper and a full unit-test file, and
// the buttons still never appeared — the renderer's hand-listed prop
// pass-through simply didn't forward the field, so the qBittorrent Files tab
// showed All / None and no Audio / Video. Only rendering the real chain can
// tell you a list-level field survives the trip.
afterEach(cleanup);

const NODE: PluginViewData = {
  type: "track-row-list",
  selectable: true,
  items: [
    { id: "0", title: "01 Nude.flac" },
    { id: "1", title: "cover.jpg" },
    { id: "2", title: "02 Reckoner.flac" },
  ],
  selectionPresets: [
    { id: "audio", label: "Audio", ids: ["0", "2"] },
    { id: "video", label: "Video", ids: [] },
  ],
  actions: [{ id: "qbt:play-file", label: "Play" }],
};

function view(node: PluginViewData = NODE) {
  return render(
    <PluginViewRenderer pluginName="qBittorrent" data={node} currentTrack={null} />,
  );
}

describe("track-row-list selection presets", () => {
  it("renders the plugin's presets alongside the host's All / None", () => {
    const { getByText } = view();
    expect(getByText("All")).toBeTruthy();
    expect(getByText("None")).toBeTruthy();
    expect(getByText("Audio")).toBeTruthy();
    expect(getByText("Video")).toBeTruthy();
  });

  it("selects exactly the preset's rows", () => {
    const { getByText } = view();
    expect(getByText("0 / 3")).toBeTruthy();
    fireEvent.click(getByText("Audio"));
    expect(getByText("2 / 3")).toBeTruthy();
  });

  // A preset with nothing on screen is offered but dead, rather than silently
  // clearing the selection when pressed.
  it("disables a preset that matches no row", () => {
    const { getByText } = view();
    expect((getByText("Video") as HTMLButtonElement).disabled).toBe(true);
    expect((getByText("Audio") as HTMLButtonElement).disabled).toBe(false);
  });

  it("still shows All / None for a list that declares no presets", () => {
    const { getByText, queryByText } = view({ ...NODE, selectionPresets: undefined } as PluginViewData);
    expect(getByText("All")).toBeTruthy();
    expect(queryByText("Audio")).toBeNull();
  });
});
