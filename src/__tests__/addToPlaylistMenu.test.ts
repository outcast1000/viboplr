import { describe, it, expect, vi } from "vitest";
import { buildAddToPlaylistSubmenu, ADD_TO_PLAYLIST_MENU_CAP } from "../contextMenu/addToPlaylistMenu";

const PLAYLISTS = [
  { id: 1, name: "Road Trip" },
  { id: 2, name: "Focus" },
  { id: 3, name: "Gym" },
];

describe("buildAddToPlaylistSubmenu", () => {
  it("returns a submenu with each playlist, a separator, then New playlist… last", () => {
    const spec = buildAddToPlaylistSubmenu(PLAYLISTS, { onPick: vi.fn(), onNew: vi.fn() });
    expect(spec.kind).toBe("submenu");
    if (spec.kind !== "submenu") return;
    expect(spec.text).toBe("Add to Playlist");
    expect(spec.items.map(i => (i.kind === "separator" ? "—" : i.text))).toEqual([
      "Road Trip", "Focus", "Gym", "—", "New playlist…",
    ]);
  });

  it("omits the separator when no playlists exist", () => {
    const spec = buildAddToPlaylistSubmenu([], { onPick: vi.fn(), onNew: vi.fn() });
    if (spec.kind !== "submenu") throw new Error("expected submenu");
    expect(spec.items).toHaveLength(1);
    expect(spec.items[0].kind === "item" && spec.items[0].text).toBe("New playlist…");
  });

  it("honors excludeId (a playlist detail view excludes itself)", () => {
    const spec = buildAddToPlaylistSubmenu(PLAYLISTS, { onPick: vi.fn(), onNew: vi.fn(), excludeId: 2 });
    if (spec.kind !== "submenu") throw new Error("expected submenu");
    const texts = spec.items.filter(i => i.kind === "item").map(i => (i as { text: string }).text);
    expect(texts).toEqual(["Road Trip", "Gym", "New playlist…"]);
  });

  it("still offers only New playlist… when excludeId removes the last playlist", () => {
    const spec = buildAddToPlaylistSubmenu([{ id: 7, name: "Only" }], { onPick: vi.fn(), onNew: vi.fn(), excludeId: 7 });
    if (spec.kind !== "submenu") throw new Error("expected submenu");
    expect(spec.items.map(i => (i.kind === "separator" ? "—" : i.text))).toEqual(["New playlist…"]);
  });

  it("caps the list and offers the picker only past ADD_TO_PLAYLIST_MENU_CAP", () => {
    const many = Array.from({ length: ADD_TO_PLAYLIST_MENU_CAP + 5 }, (_, i) => ({ id: i + 1, name: `PL ${i + 1}` }));
    const onBrowse = vi.fn();
    const spec = buildAddToPlaylistSubmenu(many, { onPick: vi.fn(), onNew: vi.fn(), onBrowse });
    if (spec.kind !== "submenu") throw new Error("expected submenu");
    const items = spec.items.filter(i => i.kind === "item") as Array<{ text: string; action: () => void }>;
    // Cap + picker entry + New playlist…
    expect(items).toHaveLength(ADD_TO_PLAYLIST_MENU_CAP + 2);
    expect(items[0].text).toBe("PL 1"); // recency order preserved (caller pre-sorts)
    expect(items[ADD_TO_PLAYLIST_MENU_CAP].text).toBe(`All ${many.length} playlists…`);
    items[ADD_TO_PLAYLIST_MENU_CAP].action();
    expect(onBrowse).toHaveBeenCalledOnce();
  });

  it("does not cap at or below the threshold, and never without onBrowse", () => {
    const exactly = Array.from({ length: ADD_TO_PLAYLIST_MENU_CAP }, (_, i) => ({ id: i + 1, name: `PL ${i + 1}` }));
    const atCap = buildAddToPlaylistSubmenu(exactly, { onPick: vi.fn(), onNew: vi.fn(), onBrowse: vi.fn() });
    if (atCap.kind !== "submenu") throw new Error("expected submenu");
    expect(atCap.items.filter(i => i.kind === "item")).toHaveLength(ADD_TO_PLAYLIST_MENU_CAP + 1); // no picker entry

    const many = Array.from({ length: ADD_TO_PLAYLIST_MENU_CAP + 5 }, (_, i) => ({ id: i + 1, name: `PL ${i + 1}` }));
    const noBrowse = buildAddToPlaylistSubmenu(many, { onPick: vi.fn(), onNew: vi.fn() });
    if (noBrowse.kind !== "submenu") throw new Error("expected submenu");
    // Without a picker to defer to, listing everything beats hiding playlists.
    expect(noBrowse.items.filter(i => i.kind === "item")).toHaveLength(many.length + 1);
  });

  it("applies excludeId before deciding whether to cap", () => {
    const many = Array.from({ length: ADD_TO_PLAYLIST_MENU_CAP + 1 }, (_, i) => ({ id: i + 1, name: `PL ${i + 1}` }));
    const spec = buildAddToPlaylistSubmenu(many, { onPick: vi.fn(), onNew: vi.fn(), onBrowse: vi.fn(), excludeId: 1 });
    if (spec.kind !== "submenu") throw new Error("expected submenu");
    // Exclusion brings it to exactly the cap → no picker entry.
    expect(spec.items.filter(i => i.kind === "item")).toHaveLength(ADD_TO_PLAYLIST_MENU_CAP + 1);
  });

  it("routes a pick to onPick with the playlist's id and name, and New playlist… to onNew", () => {
    const onPick = vi.fn();
    const onNew = vi.fn();
    const spec = buildAddToPlaylistSubmenu(PLAYLISTS, { onPick, onNew });
    if (spec.kind !== "submenu") throw new Error("expected submenu");
    const focus = spec.items.find(i => i.kind === "item" && i.text === "Focus");
    if (focus?.kind !== "item") throw new Error("missing item");
    focus.action();
    expect(onPick).toHaveBeenCalledWith(2, "Focus");
    const create = spec.items.find(i => i.kind === "item" && i.text === "New playlist…");
    if (create?.kind !== "item") throw new Error("missing item");
    create.action();
    expect(onNew).toHaveBeenCalledOnce();
  });
});
