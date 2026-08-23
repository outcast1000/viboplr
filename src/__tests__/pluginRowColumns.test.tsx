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

// Through the RENDERER: a list-level field has to survive the node → component
// hand-off, which is exactly where `selectionPresets` was silently lost once.
afterEach(cleanup);

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const COLUMNS = [
  { id: "size", label: "Size", width: 88, align: "right" as const, sortable: true },
  { id: "seeders", label: "Seeders", width: 76, align: "right" as const, sortable: true },
  { id: "source", label: "Source", width: 140, sortable: false },
];

const ITEMS = [
  { id: "aaa", title: "Artist - Album [FLAC]", cells: { size: "400 MB", seeders: "120", source: "jackett" } },
  // No cells at all — the row a source reported nothing about.
  { id: "bbb", title: "Artist - Bootleg" },
];

function view(extra: Record<string, unknown> = {}) {
  const data = {
    type: "track-row-list",
    selectable: true,
    showHeader: true,
    columns: COLUMNS,
    sortBy: "seeders",
    sortDir: "desc",
    sortAction: "qbt:result-sort",
    items: ITEMS,
    ...extra,
  } as unknown as PluginViewData;
  const onAction = vi.fn();
  const r = render(
    <PluginViewRenderer pluginName="qBittorrent" currentTrack={null} data={data} onAction={onAction} />
  );
  return { ...r, onAction };
}

const cellText = (c: HTMLElement) =>
  Array.from(c.querySelectorAll(".ptr-row .ptr-col")).map((n) => n.textContent);

describe("track-row-list columns", () => {
  it("renders a header cell and a row cell per column", () => {
    const { container } = view();
    const header = Array.from(container.querySelectorAll(".ptr-header .ptr-col")).map((n) => n.textContent);
    expect(header).toEqual(["Size", "Seeders ▼", "Source"]);
    // Columns replace the fixed Album/Duration pair, and the title header
    // becomes "Name" — in a table the row is a thing, not a track title.
    expect(container.querySelector(".ptr-header .ptr-album")).toBeNull();
    expect(container.querySelector(".ptr-header-title")?.textContent).toBe("Name");
    expect(cellText(container)).toEqual(["400 MB", "120", "jackett", "—", "—", "—"]);
  });

  it("gives header and row cells the same width, or nothing lines up", () => {
    // The two live in different DOM subtrees — a `.ptr-header` sibling and the
    // row's column slot — so identical inline widths are the only thing keeping
    // a column straight down the list.
    const { container } = view();
    const head = container.querySelectorAll<HTMLElement>(".ptr-header .ptr-col");
    const row = container.querySelectorAll<HTMLElement>(".ptr-row .ptr-col");
    expect(head[0].style.width).toBe("88px");
    expect(row[0].style.width).toBe("88px");
    expect(head[0].style.textAlign).toBe("right");
    // No width declared → the shared default, not "auto" on one side only.
    expect(head[2].style.width).toBe(row[2].style.width);
  });

  it("reports a sort click and flips only the sorted column", () => {
    const { container, onAction } = view();
    const head = container.querySelectorAll(".ptr-header .ptr-col");
    // The sorted column flips…
    fireEvent.click(head[1]);
    expect(onAction).toHaveBeenLastCalledWith("qbt:result-sort", { column: "seeders", direction: "asc" });
    // …a fresh one starts at "desc", the useful end of every number here.
    fireEvent.click(head[0]);
    expect(onAction).toHaveBeenLastCalledWith("qbt:result-sort", { column: "size", direction: "desc" });
  });

  it("makes only sortable columns clickable", () => {
    const { container, onAction } = view();
    const head = container.querySelectorAll(".ptr-header .ptr-col");
    expect(head[0].tagName).toBe("BUTTON");
    expect(head[2].tagName).toBe("SPAN");
    fireEvent.click(head[2]);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("renders no sort buttons when the plugin declares no sortAction", () => {
    // Reporting a click nobody asked for would leave the arrow stuck on a
    // column the plugin never re-orders by.
    const { container } = view({ sortAction: undefined });
    expect(container.querySelectorAll(".ptr-header button").length).toBe(0);
  });

  it("drops the trailing duration slot, so a figure isn't printed twice", () => {
    const { container } = view({
      items: [{ id: "aaa", title: "x", duration: "400 MB", cells: { size: "400 MB" } }],
    });
    expect(container.querySelector(".ptr-row .ptr-duration")).toBeNull();
  });

  it("leaves a list without columns exactly as it was", () => {
    const { container } = view({
      columns: undefined,
      sortAction: undefined,
      items: [{ id: "aaa", title: "x", album: "Album name", duration: "3:20" }],
    });
    const header = Array.from(container.querySelectorAll(".ptr-header > *")).map((n) => n.textContent);
    expect(header).toEqual(["", "Title", "Album", "Duration"]);
    expect(container.querySelector(".ptr-row .ptr-album")?.textContent).toBe("Album name");
    expect(container.querySelector(".ptr-row .ptr-duration")?.textContent).toBe("3:20");
  });
});
