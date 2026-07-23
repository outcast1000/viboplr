import { describe, it, expect, vi } from "vitest";
import {
  resolveShelves,
  findUnattemptedShelfKeys,
  findUnattemptedBuiltInKeys,
  findMissingRenderedShelfKeys,
  resolveSessionCover,
  RADIO_SHELF_ID,
  type ShelfResolver,
} from "../hooks/useHome";
import type { RecentPlaySession } from "../utils/recentPlays";

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

describe("findUnattemptedBuiltInKeys", () => {
  // After a refresh with defaults, attemptedKeys holds the default-visible shelves.
  // "builtin:recently-liked" is off by default, so it was never attempted.
  it("flags a default-off built-in the user just enabled via Customize", () => {
    const attempted = new Set(["builtin:recently-played", "builtin:liked-albums"]);
    const visibility = { "builtin:recently-liked": true };
    const result = findUnattemptedBuiltInKeys(visibility, attempted);
    expect(result).toContain("builtin:recently-liked");
  });

  it("does not flag a default-off shelf the user has not enabled", () => {
    const attempted = new Set(["builtin:recently-played"]);
    // No explicit visibility -> default-off shelves stay hidden, so not fetched.
    expect(findUnattemptedBuiltInKeys({}, attempted)).not.toContain("builtin:recently-liked");
  });

  it("does not flag a built-in that was already attempted last refresh", () => {
    const attempted = new Set(["builtin:recently-played"]);
    // recently-played is on by default and was attempted; should not re-trigger.
    expect(findUnattemptedBuiltInKeys({}, attempted)).not.toContain("builtin:recently-played");
  });

  it("never flags the Radio shelf (its data is fetched independently)", () => {
    const attempted = new Set<string>();
    const visibility = { [RADIO_SHELF_ID]: true };
    expect(findUnattemptedBuiltInKeys(visibility, attempted)).not.toContain(RADIO_SHELF_ID);
  });
});

describe("findMissingRenderedShelfKeys", () => {
  const shelves = [
    { pluginId: "spotify", shelfId: "discover" },
    { pluginId: "tidal", shelfId: "mixes" },
  ];

  it("flags a registered, visible plugin shelf that isn't currently rendered", () => {
    // spotify:discover is on screen; tidal:mixes registered but was pruned/dropped.
    const rendered = new Set(["spotify:discover", "builtin:recently-played"]);
    expect(findMissingRenderedShelfKeys(shelves, {}, rendered)).toEqual(["tidal:mixes"]);
  });

  it("returns empty when every visible plugin shelf is rendered", () => {
    const rendered = new Set(["spotify:discover", "tidal:mixes"]);
    expect(findMissingRenderedShelfKeys(shelves, {}, rendered)).toEqual([]);
  });

  it("ignores shelves the user has hidden", () => {
    const rendered = new Set(["spotify:discover"]);
    const visibility = { "tidal:mixes": false };
    expect(findMissingRenderedShelfKeys(shelves, visibility, rendered)).toEqual([]);
  });

  it("recovers a corrupted snapshot: attempted-but-not-rendered still counts as missing", () => {
    // The old prune could persist a shelf key in attemptedKeys while dropping the
    // shelf itself. findUnattemptedShelfKeys would say "nothing new" (both attempted),
    // but findMissingRenderedShelfKeys catches the one that isn't on screen.
    const attempted = new Set(["spotify:discover", "tidal:mixes"]);
    expect(findUnattemptedShelfKeys(shelves, {}, attempted)).toEqual([]);
    const rendered = new Set(["spotify:discover"]); // tidal dropped from display
    expect(findMissingRenderedShelfKeys(shelves, {}, rendered)).toEqual(["tidal:mixes"]);
  });
});

describe("resolveSessionCover", () => {
  function session(overrides: Partial<RecentPlaySession>): RecentPlaySession {
    return { source: "track", name: "X", ts: 0, ...overrides };
  }

  it("prefers the cover captured at play time", async () => {
    const resolve = vi.fn(async () => "/should/not/be/called.jpg");
    const cover = await resolveSessionCover(
      session({ source: "album", name: "Greatest", imagePath: "/captured.jpg" }),
      resolve,
    );
    expect(cover).toBe("/captured.jpg");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("re-resolves an album session by name when no captured cover", async () => {
    const resolve = vi.fn(async (album: string | null | undefined) => (album === "Greatest" ? "/album.jpg" : null));
    const cover = await resolveSessionCover(session({ source: "album", name: "Greatest", artistName: "Artie" }), resolve);
    expect(cover).toBe("/album.jpg");
    expect(resolve).toHaveBeenCalledWith("Greatest", "Artie");
  });

  it("re-resolves an artist session by name", async () => {
    const resolve = vi.fn(async (_album: string | null | undefined, artist: string | null | undefined) => (artist === "Artie" ? "/artist.jpg" : null));
    const cover = await resolveSessionCover(session({ source: "artist", name: "Artie" }), resolve);
    expect(cover).toBe("/artist.jpg");
    expect(resolve).toHaveBeenCalledWith(null, "Artie");
  });

  it("falls back to the lead track's album/artist for non-entity sources", async () => {
    const resolve = vi.fn(async (album: string | null | undefined) => (album === "Tape Album" ? "/track-album.jpg" : null));
    const cover = await resolveSessionCover(
      session({ source: "tag", name: "chill", track: { key: "ext:1", path: null, title: "Song", artist_name: "Artie", album_title: "Tape Album", duration_secs: null, format: null, liked: 0 } }),
      resolve,
    );
    expect(cover).toBe("/track-album.jpg");
    expect(resolve).toHaveBeenCalledWith("Tape Album", "Artie");
  });

  it("returns null when nothing resolves (placeholder territory)", async () => {
    const resolve = vi.fn(async () => null);
    const cover = await resolveSessionCover(session({ source: "playlist", name: "Mix" }), resolve);
    expect(cover).toBeNull();
  });
});
