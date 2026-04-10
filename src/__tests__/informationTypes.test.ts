import { describe, it, expect } from "vitest";

const ERROR_TTL = 3600; // 1 hour

type Status = "ok" | "not_found" | "error";

interface CacheEntry {
  status: Status;
  fetchedAt: number;
}

/** Pure function: given a cache entry and info type TTL, decide what to do */
function decideCacheAction(
  entry: CacheEntry | null,
  ttl: number,
  now: number,
): "render" | "render_and_refetch" | "loading" | "empty" {
  if (!entry) return "loading";

  const age = now - entry.fetchedAt;
  const effectiveTtl = entry.status === "error" ? ERROR_TTL : ttl;
  const stale = age >= effectiveTtl;

  if (entry.status === "ok") {
    return stale ? "render_and_refetch" : "render";
  }
  if (entry.status === "not_found") {
    return stale ? "loading" : "empty";
  }
  // error
  return stale ? "loading" : "empty";
}

describe("decideCacheAction", () => {
  const now = 1000000;

  it("returns loading when no cache entry", () => {
    expect(decideCacheAction(null, 90 * 86400, now)).toBe("loading");
  });

  it("renders fresh ok data", () => {
    expect(decideCacheAction({ status: "ok", fetchedAt: now - 100 }, 90 * 86400, now)).toBe("render");
  });

  it("renders stale ok data and triggers refetch", () => {
    expect(decideCacheAction({ status: "ok", fetchedAt: now - 90 * 86400 - 1 }, 90 * 86400, now)).toBe("render_and_refetch");
  });

  it("shows empty state for fresh not_found", () => {
    expect(decideCacheAction({ status: "not_found", fetchedAt: now - 100 }, 90 * 86400, now)).toBe("empty");
  });

  it("retries stale not_found", () => {
    expect(decideCacheAction({ status: "not_found", fetchedAt: now - 90 * 86400 - 1 }, 90 * 86400, now)).toBe("loading");
  });

  it("shows empty state for fresh error (within 1 hour)", () => {
    expect(decideCacheAction({ status: "error", fetchedAt: now - 1800 }, 90 * 86400, now)).toBe("empty");
  });

  it("retries stale error (after 1 hour)", () => {
    expect(decideCacheAction({ status: "error", fetchedAt: now - 3601 }, 90 * 86400, now)).toBe("loading");
  });

  it("error TTL is independent of info type TTL", () => {
    expect(decideCacheAction({ status: "error", fetchedAt: now - 3601 }, 30 * 86400, now)).toBe("loading");
  });
});
