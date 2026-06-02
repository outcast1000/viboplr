import { describe, it, expect, vi } from "vitest";
import { resolveShelves, findUnattemptedShelfKeys, type ShelfResolver } from "../hooks/useHome";

function makeResolver(name: string, fn: () => Promise<unknown>): ShelfResolver {
  return { id: name, title: name, displayKind: "album-cards", limit: 5, fetch: fn as ShelfResolver["fetch"] };
}

describe("resolveShelves", () => {
  it("returns ok shelves and skips empty/error/timeout", async () => {
    const ok = makeResolver("ok", async () => ({ status: "ok", items: [{ libraryId: 1, name: "x" }] }));
    const empty = makeResolver("empty", async () => ({ status: "empty" }));
    const err = makeResolver("err", async () => ({ status: "error", message: "boom" }));
    const slow = makeResolver("slow", () => new Promise(() => {})); // never resolves

    const result = await resolveShelves([ok, empty, err, slow], { timeoutMs: 50 });
    expect(result.map(r => r.id)).toEqual(["ok"]);
    expect(result[0].items).toHaveLength(1);
  });

  it("isolates errors so one failing resolver does not break others", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = makeResolver("good", async () => ({ status: "ok", items: [{ libraryId: 2, name: "y" }] }));
    const throws = makeResolver("throws", async () => { throw new Error("nope"); });
    const result = await resolveShelves([throws, good], { timeoutMs: 50 });
    expect(result.map(r => r.id)).toEqual(["good"]);
    consoleErr.mockRestore();
  });
});

describe("findUnattemptedShelfKeys", () => {
  const shelves = [
    { pluginId: "spotify", shelfId: "discover" },
    { pluginId: "tidal", shelfId: "mixes" },
  ];

  it("flags a freshly-installed plugin shelf that was never attempted", () => {
    // Snapshot is fresh and only ever attempted the spotify shelf; tidal was
    // just installed.
    const attempted = new Set(["spotify:discover", "builtin:recently-played"]);
    const result = findUnattemptedShelfKeys(shelves, {}, attempted);
    expect(result).toEqual(["tidal:mixes"]);
  });

  it("returns empty when every visible plugin shelf was already attempted", () => {
    const attempted = new Set(["spotify:discover", "tidal:mixes"]);
    expect(findUnattemptedShelfKeys(shelves, {}, attempted)).toEqual([]);
  });

  it("ignores shelves the user has hidden", () => {
    const attempted = new Set(["spotify:discover"]);
    const visibility = { "tidal:mixes": false };
    expect(findUnattemptedShelfKeys(shelves, visibility, attempted)).toEqual([]);
  });

  it("treats missing visibility keys as visible", () => {
    const attempted = new Set<string>();
    const result = findUnattemptedShelfKeys(shelves, {}, attempted);
    expect(result).toEqual(["spotify:discover", "tidal:mixes"]);
  });
});
