import { describe, it, expect } from "vitest";
import {
  orderResolvedShelves,
  mergeShelfOrder,
  completeShelfOrder,
  moveShelf,
  buildRadioShelf,
  isShelfVisible,
  RADIO_SHELF_ID,
  DEFAULT_SHELF_ORDER,
  type ResolvedShelf,
  type RadioStation,
} from "../hooks/useHome";
import type { Track } from "../types";
import { buildHomeShelfMenuSpecs } from "../contextMenu/buildHomeShelfMenuSpecs";
import type { MenuItemSpec } from "../nativeMenu";

function shelf(id: string, pluginId?: string): ResolvedShelf {
  return { id, pluginId, title: id, displayKind: "album-cards", items: [] };
}

function station(title: string, artist: string | null, cover: string | null): RadioStation {
  return { seed: { title, artist_name: artist } as Track, coverUrl: cover };
}

const ids = (shelves: ResolvedShelf[]) => shelves.map((s) => s.id);

describe("orderResolvedShelves", () => {
  it("keeps built-ins in the given order", () => {
    const shelves = [shelf("builtin:a"), shelf("builtin:b"), shelf("builtin:c")];
    const ordered = orderResolvedShelves(shelves, ["builtin:c", "builtin:a", "builtin:b"]);
    expect(ids(ordered)).toEqual(["builtin:c", "builtin:a", "builtin:b"]);
  });

  it("reorders regardless of the input array order", () => {
    const shelves = [shelf("builtin:c"), shelf("builtin:b"), shelf("builtin:a")];
    const ordered = orderResolvedShelves(shelves, ["builtin:a", "builtin:b", "builtin:c"]);
    expect(ids(ordered)).toEqual(["builtin:a", "builtin:b", "builtin:c"]);
  });

  it("appends an unknown/new built-in after the listed built-ins but before plugins", () => {
    const shelves = [shelf("builtin:new"), shelf("builtin:a"), shelf("plug:x", "plug")];
    const ordered = orderResolvedShelves(shelves, ["builtin:a"]);
    expect(ids(ordered)).toEqual(["builtin:a", "builtin:new", "plug:x"]);
  });

  it("always places plugin shelves after built-ins, preserving their relative order", () => {
    const shelves = [
      shelf("plug:x", "plug"),
      shelf("builtin:b"),
      shelf("plug:y", "plug"),
      shelf("builtin:a"),
    ];
    const ordered = orderResolvedShelves(shelves, ["builtin:a", "builtin:b"]);
    expect(ids(ordered)).toEqual(["builtin:a", "builtin:b", "plug:x", "plug:y"]);
  });

  it("ranks a placed plugin shelf by its position in the order, even above built-ins", () => {
    const shelves = [shelf("builtin:a"), shelf("builtin:b"), shelf("plug:x", "plug")];
    const ordered = orderResolvedShelves(shelves, ["plug:x", "builtin:a", "builtin:b"]);
    expect(ids(ordered)).toEqual(["plug:x", "builtin:a", "builtin:b"]);
  });

  it("puts unplaced plugin shelves after placed ones of either kind", () => {
    const shelves = [shelf("plug:y", "plug"), shelf("builtin:a"), shelf("plug:x", "plug")];
    const ordered = orderResolvedShelves(shelves, ["builtin:a", "plug:x"]);
    expect(ids(ordered)).toEqual(["builtin:a", "plug:x", "plug:y"]);
  });

  it("does not mutate the input array", () => {
    const shelves = [shelf("builtin:b"), shelf("builtin:a")];
    const copy = ids(shelves);
    orderResolvedShelves(shelves, ["builtin:a", "builtin:b"]);
    expect(ids(shelves)).toEqual(copy);
  });
});

describe("mergeShelfOrder", () => {
  it("inserts a brand-new built-in at its default position (Radio leads)", () => {
    // A profile saved before Radio existed (the 7 non-radio ids in default order).
    const saved = DEFAULT_SHELF_ORDER.filter((id) => id !== RADIO_SHELF_ID);
    expect(mergeShelfOrder(saved)).toEqual(DEFAULT_SHELF_ORDER);
  });

  it("keeps the user's arrangement and only fills in missing ids", () => {
    const merged = mergeShelfOrder(["builtin:liked-albums", "builtin:recently-played"]);
    // The two saved ids keep their relative order...
    expect(merged.indexOf("builtin:liked-albums")).toBeLessThan(merged.indexOf("builtin:recently-played"));
    // ...and every default id is present.
    for (const id of DEFAULT_SHELF_ORDER) expect(merged).toContain(id);
  });

  it("drops ids no longer known", () => {
    const merged = mergeShelfOrder(["builtin:gone", ...DEFAULT_SHELF_ORDER]);
    expect(merged).not.toContain("builtin:gone");
    expect([...merged].sort()).toEqual([...DEFAULT_SHELF_ORDER].sort());
  });

  it("returns the default order unchanged", () => {
    expect(mergeShelfOrder(DEFAULT_SHELF_ORDER)).toEqual(DEFAULT_SHELF_ORDER);
  });

  it("keeps plugin shelf ids where the user put them, installed or not", () => {
    const saved = ["acme:top", ...DEFAULT_SHELF_ORDER.slice(0, 3), "gone:shelf", ...DEFAULT_SHELF_ORDER.slice(3)];
    expect(mergeShelfOrder(saved)).toEqual(saved);
  });

  it("slots a new built-in after its default predecessor, not by raw index", () => {
    // A plugin shelf placed at the top shifts every index by one; a missing
    // built-in must still land right after the built-in that precedes it.
    const missing = DEFAULT_SHELF_ORDER[2];
    const saved = ["acme:top", ...DEFAULT_SHELF_ORDER.filter((id) => id !== missing)];
    const merged = mergeShelfOrder(saved);
    expect(merged.indexOf(missing)).toBe(merged.indexOf(DEFAULT_SHELF_ORDER[1]) + 1);
    expect(merged[0]).toBe("acme:top");
  });

  it("drops duplicate ids", () => {
    expect(mergeShelfOrder([...DEFAULT_SHELF_ORDER, DEFAULT_SHELF_ORDER[0], "acme:x", "acme:x"]))
      .toEqual([...DEFAULT_SHELF_ORDER, "acme:x"]);
  });
});

describe("completeShelfOrder", () => {
  it("appends ids the order doesn't list, in the order given, once", () => {
    expect(completeShelfOrder(["a", "b"], ["b", "x", "y", "x"])).toEqual(["a", "b", "x", "y"]);
  });
});

describe("moveShelf", () => {
  it("moves an id to just before or after a target", () => {
    expect(moveShelf(["a", "b", "c", "d"], "d", "b", "before")).toEqual(["a", "d", "b", "c"]);
    expect(moveShelf(["a", "b", "c", "d"], "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
  });

  it("returns the order unchanged when either id is missing", () => {
    const order = ["a", "b"];
    expect(moveShelf(order, "z", "a", "before")).toBe(order);
    expect(moveShelf(order, "a", "z", "after")).toBe(order);
    expect(moveShelf(order, "a", "a", "after")).toBe(order);
  });
});

describe("buildHomeShelfMenuSpecs", () => {
  const noop = () => {};
  const specs = (index: number, count: number) =>
    buildHomeShelfMenuSpecs({ index, count, onMoveUp: noop, onMoveDown: noop, onHide: noop, onCustomize: noop });
  const enabled = (s: MenuItemSpec[], text: string) =>
    s.find((x) => x.kind === "item" && x.text === text) as { enabled?: boolean } | undefined;

  it("disables Move up on the hero and Move down on the last shelf", () => {
    expect(enabled(specs(0, 3), "Move up")?.enabled).toBe(false);
    expect(enabled(specs(0, 3), "Move down")?.enabled).toBe(true);
    expect(enabled(specs(2, 3), "Move down")?.enabled).toBe(false);
    expect(enabled(specs(1, 3), "Move up")?.enabled).toBe(true);
  });

  it("always offers Hide and Customize", () => {
    const texts = specs(0, 1).flatMap((x) => (x.kind === "item" ? [x.text] : []));
    expect(texts).toContain("Hide this shelf");
    expect(texts).toContain("Customize Home…");
  });
});

describe("isShelfVisible", () => {
  it("honors an explicit user setting over the default", () => {
    // A default-hidden shelf turned on, and a default-visible shelf turned off.
    expect(isShelfVisible("builtin:never-played", { "builtin:never-played": true })).toBe(true);
    expect(isShelfVisible(RADIO_SHELF_ID, { [RADIO_SHELF_ID]: false })).toBe(false);
  });

  it("falls back to the built-in default when unset", () => {
    expect(isShelfVisible(RADIO_SHELF_ID, {})).toBe(true); // curated: on
    expect(isShelfVisible("builtin:never-played", {})).toBe(false); // curated: off
    expect(isShelfVisible("builtin:liked-albums", {})).toBe(true);
    expect(isShelfVisible("builtin:liked-artists", {})).toBe(false);
  });

  it("defaults unknown (plugin) shelves to visible", () => {
    expect(isShelfVisible("acme:shelf", {})).toBe(true);
    expect(isShelfVisible("acme:shelf", { "acme:shelf": false })).toBe(false);
  });
});

describe("buildRadioShelf", () => {
  it("produces a playlist-cards shelf routed via the __radioSeed sentinel", () => {
    const shelf = buildRadioShelf([station("Song A", "Artist A", "/covers/a.jpg")]);
    expect(shelf.id).toBe(RADIO_SHELF_ID);
    expect(shelf.displayKind).toBe("playlist-cards");
    expect(shelf.items).toHaveLength(1);

    const item = shelf.items[0] as unknown as {
      name: string; coverUrl?: string; tracks: Array<{ __radioSeed?: Track }>;
    };
    expect(item.name).toBe("Song A");
    expect(item.coverUrl).toBe("/covers/a.jpg");
    // The first track carries the seed sentinel that App.tsx reads to start radio.
    expect(item.tracks[0].__radioSeed).toBeTruthy();
    expect(item.tracks[0].__radioSeed!.title).toBe("Song A");
  });
});
