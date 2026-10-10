import { describe, it, expect } from "vitest";
import { cacheTtlForRow, CORE_LOCAL_LYRICS_PROVIDER, LOCAL_INFO_TTL, NEVER_EXPIRES, isSyncedLyricsValue, decideCacheAction as realDecideCacheAction } from "../utils/infoFetchChain";

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

describe("cacheTtlForRow", () => {
  const WEB_TTL = 90 * 86400;
  // The lyrics chain as seeded: the built-in local provider first, plugins after.
  const providers: Array<[string, number]> = [
    [CORE_LOCAL_LYRICS_PROVIDER, 7],
    ["lrclib", 8],
    ["lyrics-ovh", 9],
  ];

  it("a local (core) row expires after a day — the .lrc may have been edited", () => {
    expect(cacheTtlForRow(providers, 7, "ok", WEB_TTL)).toBe(LOCAL_INFO_TTL);
  });

  it("a web row keeps the type TTL, so lrclib is not re-asked daily", () => {
    expect(cacheTtlForRow(providers, 8, "ok", WEB_TTL)).toBe(WEB_TTL);
  });

  it("a miss expires after a day when a local provider exists", () => {
    // A chain-wide "no lyrics found" is stored under the last provider tried;
    // at the web TTL it would mask an .lrc the user adds tomorrow for 90 days.
    expect(cacheTtlForRow(providers, 9, "not_found", WEB_TTL)).toBe(LOCAL_INFO_TTL);
    expect(cacheTtlForRow(providers, 9, "error", WEB_TTL)).toBe(LOCAL_INFO_TTL);
  });

  it("types with no local provider are untouched, misses included", () => {
    const webOnly: Array<[string, number]> = [["lastfm", 3], ["genius", 4]];
    expect(cacheTtlForRow(webOnly, 3, "ok", WEB_TTL)).toBe(WEB_TTL);
    expect(cacheTtlForRow(webOnly, 4, "not_found", WEB_TTL)).toBe(WEB_TTL);
  });

  it("never raises a TTL that is already shorter than a day", () => {
    expect(cacheTtlForRow(providers, 7, "ok", 600)).toBe(600);
  });

  describe("synced lyrics never expire", () => {
    const now = 1_800_000_000;
    const tenYears = 10 * 365 * 86400;
    const synced = JSON.stringify({ text: "[00:01.00]hi", kind: "synced" });
    const plain = JSON.stringify({ text: "hi", kind: "plain" });

    it("a web, imported or hand-saved synced row has no expiry", () => {
      expect(cacheTtlForRow(providers, 8, "ok", WEB_TTL, "lyrics", synced)).toBe(NEVER_EXPIRES);
      expect(realDecideCacheAction("ok", now - tenYears, cacheTtlForRow(providers, 8, "ok", WEB_TTL, "lyrics", synced), now)).toBe("render");
    });

    it("also without a local provider in the chain", () => {
      const webOnly: Array<[string, number]> = [["lrclib", 3]];
      expect(cacheTtlForRow(webOnly, 3, "ok", WEB_TTL, "lyrics", synced)).toBe(NEVER_EXPIRES);
    });

    it("plain lyrics keep the type TTL, so a synced version is picked up later", () => {
      expect(cacheTtlForRow(providers, 8, "ok", WEB_TTL, "lyrics", plain)).toBe(WEB_TTL);
      expect(realDecideCacheAction("ok", now - WEB_TTL - 1, cacheTtlForRow(providers, 8, "ok", WEB_TTL, "lyrics", plain), now)).toBe("render_and_refetch");
    });

    it("an unreadable or missing value is not synced", () => {
      expect(cacheTtlForRow(providers, 8, "ok", WEB_TTL, "lyrics", "not json")).toBe(WEB_TTL);
      expect(cacheTtlForRow(providers, 8, "ok", WEB_TTL, "lyrics")).toBe(WEB_TTL);
      expect(isSyncedLyricsValue(null)).toBe(false);
      expect(isSyncedLyricsValue(synced)).toBe(true);
    });

    it("the local-file row still expires daily — the .lrc can change on disk", () => {
      expect(cacheTtlForRow(providers, 7, "ok", WEB_TTL, "lyrics", synced)).toBe(LOCAL_INFO_TTL);
    });

    it("misses and errors still expire, or a no-lyrics answer would be permanent", () => {
      expect(cacheTtlForRow(providers, 9, "not_found", WEB_TTL, "lyrics", synced)).toBe(LOCAL_INFO_TTL);
      expect(cacheTtlForRow(providers, 9, "error", WEB_TTL, "lyrics", null)).toBe(LOCAL_INFO_TTL);
    });

    it("other types keep their own TTL", () => {
      expect(cacheTtlForRow(providers, 8, "ok", WEB_TTL, "artist_bio", synced)).toBe(WEB_TTL);
    });
  });
});
