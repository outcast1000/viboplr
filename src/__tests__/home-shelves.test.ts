import { describe, it, expect, vi } from "vitest";
import { resolveShelves, type ShelfResolver } from "../hooks/useHome";

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
