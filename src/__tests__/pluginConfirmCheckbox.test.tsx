import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, fireEvent, screen } from "@testing-library/react";
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

// Rendered through the RENDERER, not the component: the checkbox is a node-level
// field, and the node → component hand-off is exactly where such a field gets
// silently dropped (see the selection-preset test for the precedent).
afterEach(cleanup);

const CONFIRM: PluginViewData = {
  type: "confirm",
  title: "Remove torrent",
  message: "Remove “A Release” from qBittorrent?",
  checkboxLabel: "Also delete the downloaded files from disk",
  confirmAction: "qbt:delete-confirm",
  cancelAction: "qbt:delete-cancel",
};

describe("plugin confirm checkbox", () => {
  it("reports the tick on the confirm payload", () => {
    const onAction = vi.fn();
    render(<PluginViewRenderer pluginName="qBittorrent" currentTrack={null} data={CONFIRM} onAction={onAction} />);

    // Unticked is the default and the safe answer — a destructive opt-in must
    // never arrive pre-selected.
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(screen.getByText("Confirm"));
    expect(onAction).toHaveBeenLastCalledWith("qbt:delete-confirm", { checkboxChecked: false });

    fireEvent.click(box);
    fireEvent.click(screen.getByText("Confirm"));
    expect(onAction).toHaveBeenLastCalledWith("qbt:delete-confirm", { checkboxChecked: true });
  });

  it("reports it on cancel too, so a plugin can remember the tick", () => {
    const onAction = vi.fn();
    render(<PluginViewRenderer pluginName="qBittorrent" currentTrack={null} data={CONFIRM} onAction={onAction} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(onAction).toHaveBeenLastCalledWith("qbt:delete-cancel", { checkboxChecked: true });
  });

  it("merges into an object payload instead of replacing it", () => {
    const onAction = vi.fn();
    render(
      <PluginViewRenderer pluginName="qBittorrent" currentTrack={null}
        data={{ ...CONFIRM, data: { hash: "aaa" } } as PluginViewData}
        onAction={onAction}
      />
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Confirm"));
    expect(onAction).toHaveBeenLastCalledWith("qbt:delete-confirm", {
      hash: "aaa",
      checkboxChecked: true,
    });
  });

  it("passes a non-object payload through untouched", () => {
    // Rewriting a bare payload into an object would break the plugin's own read
    // of `data` — the tick is simply unreportable there.
    const onAction = vi.fn();
    render(<PluginViewRenderer pluginName="qBittorrent" currentTrack={null} data={{ ...CONFIRM, data: "aaa" } as PluginViewData} onAction={onAction} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Confirm"));
    expect(onAction).toHaveBeenLastCalledWith("qbt:delete-confirm", "aaa");
  });

  it("renders no checkbox, and no payload field, without a label", () => {
    const onAction = vi.fn();
    const { checkboxLabel: _drop, ...plain } = CONFIRM as Record<string, unknown>;
    render(<PluginViewRenderer pluginName="qBittorrent" currentTrack={null} data={plain as PluginViewData} onAction={onAction} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByText("Confirm"));
    expect(onAction).toHaveBeenLastCalledWith("qbt:delete-confirm", undefined);
  });

  it("keeps the tick when Enter confirms from the keyboard", () => {
    const onAction = vi.fn();
    render(<PluginViewRenderer pluginName="qBittorrent" currentTrack={null} data={CONFIRM} onAction={onAction} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onAction).toHaveBeenLastCalledWith("qbt:delete-confirm", { checkboxChecked: true });
  });
});
