import { describe, it, expect, vi } from "vitest";
import { resolveStreamChain, type StreamResolver } from "../streamResolvers";

function makeResolver(
  overrides: Partial<StreamResolver> & { id: string },
): StreamResolver {
  return {
    name: overrides.id,
    source: "test",
    resolve: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("resolveStreamChain", () => {
  it("returns first non-null result", async () => {
    const resolvers: StreamResolver[] = [
      makeResolver({ id: "a", resolve: vi.fn().mockResolvedValue(null) }),
      makeResolver({
        id: "b",
        resolve: vi.fn().mockResolvedValue({ url: "tidal://123", label: "TIDAL" }),
      }),
      makeResolver({ id: "c", resolve: vi.fn().mockResolvedValue(null) }),
    ];

    const result = await resolveStreamChain(resolvers, "Title", "Artist", "Album");
    expect(result).toEqual({ url: "tidal://123", label: "TIDAL" });
    // Resolver c should not be called since b returned a result
    expect(resolvers[2].resolve).not.toHaveBeenCalled();
  });

  it("returns null when all resolvers return null", async () => {
    const resolvers: StreamResolver[] = [
      makeResolver({ id: "a" }),
      makeResolver({ id: "b" }),
    ];

    const result = await resolveStreamChain(resolvers, "Title", "Artist", null);
    expect(result).toBeNull();
  });

  it("skips resolvers that throw errors", async () => {
    const resolvers: StreamResolver[] = [
      makeResolver({
        id: "a",
        resolve: vi.fn().mockRejectedValue(new Error("network error")),
      }),
      makeResolver({
        id: "b",
        resolve: vi.fn().mockResolvedValue({ url: "file:///song.mp3", label: "Library" }),
      }),
    ];

    const result = await resolveStreamChain(resolvers, "Title", null, null);
    expect(result).toEqual({ url: "file:///song.mp3", label: "Library" });
  });

  it("skips resolvers that exceed timeout", async () => {
    const slowResolve = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ url: "slow://1", label: "Slow" }), 10_000)),
    );
    const resolvers: StreamResolver[] = [
      makeResolver({ id: "slow", resolve: slowResolve }),
      makeResolver({
        id: "fast",
        resolve: vi.fn().mockResolvedValue({ url: "tidal://1", label: "TIDAL" }),
      }),
    ];

    const result = await resolveStreamChain(resolvers, "Title", "Artist", null, 50);
    expect(result).toEqual({ url: "tidal://1", label: "TIDAL" });
  });

  it("returns null for empty resolver list", async () => {
    const result = await resolveStreamChain([], "Title", "Artist", null);
    expect(result).toBeNull();
  });
});
