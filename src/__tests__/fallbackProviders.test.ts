import { describe, it, expect, vi } from "vitest";
import { resolveFallback, type FallbackProvider } from "../fallbackProviders";

function makeProvider(
  overrides: Partial<FallbackProvider> & { id: string },
): FallbackProvider {
  return {
    name: overrides.id,
    source: "test",
    resolve: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("resolveFallback", () => {
  it("returns first non-null result", async () => {
    const providers: FallbackProvider[] = [
      makeProvider({ id: "a", resolve: vi.fn().mockResolvedValue(null) }),
      makeProvider({
        id: "b",
        resolve: vi.fn().mockResolvedValue({ url: "tidal://123", label: "TIDAL" }),
      }),
      makeProvider({ id: "c", resolve: vi.fn().mockResolvedValue(null) }),
    ];

    const result = await resolveFallback(providers, "Title", "Artist", "Album");
    expect(result).toEqual({ url: "tidal://123", label: "TIDAL" });
    // Provider c should not be called since b returned a result
    expect(providers[2].resolve).not.toHaveBeenCalled();
  });

  it("returns null when all providers return null", async () => {
    const providers: FallbackProvider[] = [
      makeProvider({ id: "a" }),
      makeProvider({ id: "b" }),
    ];

    const result = await resolveFallback(providers, "Title", "Artist", null);
    expect(result).toBeNull();
  });

  it("skips providers that throw errors", async () => {
    const providers: FallbackProvider[] = [
      makeProvider({
        id: "a",
        resolve: vi.fn().mockRejectedValue(new Error("network error")),
      }),
      makeProvider({
        id: "b",
        resolve: vi.fn().mockResolvedValue({ url: "file:///song.mp3", label: "Library" }),
      }),
    ];

    const result = await resolveFallback(providers, "Title", null, null);
    expect(result).toEqual({ url: "file:///song.mp3", label: "Library" });
  });

  it("skips providers that exceed timeout", async () => {
    const slowResolve = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ url: "slow://1", label: "Slow" }), 10_000)),
    );
    const providers: FallbackProvider[] = [
      makeProvider({ id: "slow", resolve: slowResolve }),
      makeProvider({
        id: "fast",
        resolve: vi.fn().mockResolvedValue({ url: "tidal://1", label: "TIDAL" }),
      }),
    ];

    const result = await resolveFallback(providers, "Title", "Artist", null, 50);
    expect(result).toEqual({ url: "tidal://1", label: "TIDAL" });
  });

  it("returns null for empty provider list", async () => {
    const result = await resolveFallback([], "Title", "Artist", null);
    expect(result).toBeNull();
  });
});
