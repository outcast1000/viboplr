import { describe, it, expect } from "vitest";
import { orderResolvedShelves, type ResolvedShelf } from "../hooks/useHome";

function shelf(id: string, pluginId?: string): ResolvedShelf {
  return { id, pluginId, title: id, displayKind: "album-cards", items: [] };
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
