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

// A hover action pressed on a scrolled-down row, with nothing selected yet, used
// to do nothing but scroll the list to the top. WebKit doesn't focus a clicked
// <button>, so the press focused the LISTBOX; its focus handler seeded the
// keyboard cursor on row 0 and scrolled that into view, so the mouseup landed on
// a different element and the click never reached the button. Selecting a row
// first "fixed" it only because the cursor was then already seeded.
afterEach(cleanup);

const scrolled: Element[] = [];
Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };

const ITEMS = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, title: `Song ${i}` }));

function view(onAction = vi.fn()) {
  const data = {
    type: "track-row-list",
    selectable: true,
    items: ITEMS,
    actions: [{ id: "download-file", label: "Download", icon: "⬇" }],
  } as PluginViewData;
  const r = render(<PluginViewRenderer pluginName="Soulseek" data={data} currentTrack={null} onAction={onAction} />);
  return { ...r, onAction, listbox: r.container.querySelector('[role="listbox"]') as HTMLElement };
}

describe("track-row-list hover action on an unselected row", () => {
  it("a press that focuses the list does not move the cursor to row 0 or scroll", () => {
    const { container, listbox, onAction } = view();
    scrolled.length = 0;
    const button = container.querySelectorAll(".ptr-row")[25].querySelector(".row-hover-action") as HTMLElement;

    // What WebKit does: mousedown on the button (which stops propagation), then
    // focus lands on the nearest focusable ancestor — the listbox.
    fireEvent.mouseDown(button);
    fireEvent.focus(listbox);

    expect(container.querySelector(".ptr-row-active")).toBeNull();
    expect(scrolled).toHaveLength(0);

    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledWith("download-file", { selectedIds: ["f25"], itemId: "f25" });
  });

  it("keyboard focus still seeds the cursor on the first row", () => {
    const { container, listbox } = view();
    fireEvent.focus(listbox);
    expect(container.querySelectorAll(".ptr-row")[0].classList.contains("ptr-row-active")).toBe(true);
  });

  it("a later Tab-in after a click is still treated as keyboard focus", async () => {
    const { container, listbox } = view();
    fireEvent.mouseDown(container.querySelectorAll(".ptr-row")[3]);
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.focus(listbox);
    expect(container.querySelectorAll(".ptr-row")[0].classList.contains("ptr-row-active")).toBe(true);
  });
});
