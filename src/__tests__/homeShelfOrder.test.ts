import { describe, it, expect } from "vitest";
import {
  orderResolvedShelves,
  mergeShelfOrder,
  buildRadioShelf,
  isShelfVisible,
  RADIO_SHELF_ID,
  DEFAULT_SHELF_ORDER,
  type ResolvedShelf,
  type RadioStation,
} from "../hooks/useHome";
import type { Track } from "../types";

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
