import { describe, it, expect, vi } from "vitest";
import {
  resolveShelves,
  findUnattemptedShelfKeys,
  findUnattemptedBuiltInKeys,
  findMissingRenderedShelfKeys,
  resolveSessionCover,
  RADIO_SHELF_ID,
  BUILTIN_SHELF_DESCRIPTORS,
  dropRetiredBuiltInShelves,
  forgottenMixName,
  trackCountLabel,
  decadePlaylists,
  playlistShelfTrack,
  mixCards,
  visitAlreadyInLatestPlay,
  type ShelfResolver,
  type TrackMix,
} from "../hooks/useHome";
import type { Track } from "../types";
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

  it("lets a resolver retitle its shelf per fetch, else keeps the registered title", async () => {
    const retitled = makeResolver("retitled", async () => ({ status: "ok", title: "Fetched title", items: [{ libraryId: 1, name: "x" }] }));
    const plain = makeResolver("plain", async () => ({ status: "ok", items: [{ libraryId: 2, name: "y" }] }));
    const result = await resolveShelves([retitled, plain], { timeoutMs: 50 });
    expect(result.map(r => r.title)).toEqual(["Fetched title", "plain"]);
  });
});

describe("default shelf set", () => {
  const visibleByDefault = BUILTIN_SHELF_DESCRIPTORS.filter((d) => d.defaultVisible).map((d) => d.id);

  it("keeps the three recent-activity shelves from stacking up in a row", () => {
    // Latest play and Jump back in open the list; Recently played is last.
    expect(visibleByDefault.slice(1, 3)).toEqual(["builtin:latest-play", "builtin:jump-back-in"]);
    expect(visibleByDefault[visibleByDefault.length - 1]).toBe("builtin:recently-played");
  });

  it("has no station shelves besides the Radio carousel", () => {
    const ids = BUILTIN_SHELF_DESCRIPTORS.map((d) => d.id);
    expect(ids).not.toContain("builtin:popular-track-radio");
    expect(ids).not.toContain("builtin:liked-track-radio");
  });

  it("drops retired built-in shelves from a hydrated snapshot, keeping plugin shelves", () => {
    const snap = [
      { id: "builtin:liked-albums" },
      { id: "builtin:popular-track-radio" },
      { id: "spotify:discover", pluginId: "spotify" },
    ];
    expect(dropRetiredBuiltInShelves(snap).map((s) => s.id)).toEqual(["builtin:liked-albums", "spotify:discover"]);
  });

});

function libTrack(id: number, over: Partial<Track> = {}): Track {
  return {
    id, path: `file:///m/${id}.flac`, title: `T${id}`, artist_id: 1, artist_name: "Artist", album_id: 1,
    album_title: "Album", year: 1994, track_number: id, duration_secs: 200, format: "flac", file_size: 1,
    collection_id: 1, collection_name: "Music", liked: 0, added_at: 0, modified_at: 0, album_artist_name: null,
    ...over,
  } as Track;
}

describe("mix shelves", () => {
  it("names mixes so the queue banner stands alone", () => {
    expect(forgottenMixName("Jazz")).toBe("Forgotten Jazz");
    expect(forgottenMixName(null)).toBe("Forgotten favorites mix");
  });

  it("counts tracks in the singular and plural", () => {
    expect(trackCountLabel(1)).toBe("1 track");
    expect(trackCountLabel(25)).toBe("25 tracks");
  });

  it("turns mixes into playable cards carrying every track and the lead's album cover", async () => {
    const mix: TrackMix = {
      tag: "Jazz",
      tracks: [libTrack(1, { album_title: "Kind of Blue", album_artist_name: "Miles Davis" }), libTrack(2)],
    };
    const cover = vi.fn(async (album: string | null | undefined, artist: string | null | undefined) =>
      album === "Kind of Blue" && artist === "Miles Davis" ? "/covers/kob.jpg" : null);
    const [card] = await mixCards([mix], (m) => `forgotten:${m.tag}`, (m) => forgottenMixName(m.tag), cover);
    const c = card as { id: string; name: string; coverUrl?: string; tracks: Array<{ path?: string | null; title: string }> };
    expect(c.id).toBe("forgotten:Jazz");
    expect(c.name).toBe("Forgotten Jazz");
    expect(c.coverUrl).toBe("/covers/kob.jpg");
    // Real library paths travel with the card, so it plays without a lookup.
    expect(c.tracks.map((t) => t.path)).toEqual(["file:///m/1.flac", "file:///m/2.flac"]);
  });
});

describe("Discover by decade reads the Playlists view's decade mixes", () => {
  const row = (id: number, name: string, system_kind: string | null) =>
    ({ id, name, image_path: null, track_count: 30, system_kind });

  it("keeps only auto decade playlists, oldest first", () => {
    const rows = [
      row(1, "2000s", "auto:decade:2000s"),
      row(2, "Rock Mix", "auto:genre:rock"),
      row(3, "1970s", "auto:decade:1970s"),
      row(4, "My 1990s", null),
      row(5, "1990s", "auto:decade:1990s"),
    ];
    expect(decadePlaylists(rows).map((p) => p.name)).toEqual(["1970s", "1990s", "2000s"]);
  });

  it("ignores a decade kind it can't read a year from", () => {
    expect(decadePlaylists([row(1, "?", "auto:decade:")])).toEqual([]);
  });

  it("plays a playlist row from its own source URI", () => {
    expect(playlistShelfTrack({
      title: "T", artist_name: "A", album_name: "Al", duration_secs: 200, source: "file:///m/t.flac", image_path: null,
    })).toEqual({ title: "T", artist_name: "A", album_title: "Al", duration_secs: 200, path: "file:///m/t.flac", image_url: undefined });
  });
});

describe("visitAlreadyInLatestPlay", () => {
  const session = (over: Partial<RecentPlaySession>): RecentPlaySession =>
    ({ source: "album", name: "Blue", artistName: "Joni Mitchell", imagePath: null, track: null, ts: 1, ...over } as RecentPlaySession);

  it("drops an album the user also played, case-insensitively", () => {
    expect(visitAlreadyInLatestPlay({ name: "blue", artistName: "joni mitchell", entityKind: "album" }, [session({})])).toBe(true);
  });

  it("keeps a same-named album by another artist", () => {
    expect(visitAlreadyInLatestPlay({ name: "Blue", artistName: "Weezer", entityKind: "album" }, [session({})])).toBe(false);
  });

  it("matches artists only against artist sessions", () => {
    const artistSession = session({ source: "artist", name: "Björk", artistName: undefined });
    expect(visitAlreadyInLatestPlay({ name: "Björk", entityKind: "artist" }, [artistSession])).toBe(true);
    expect(visitAlreadyInLatestPlay({ name: "Björk", entityKind: "artist" }, [session({ name: "Björk" })])).toBe(false);
  });

  it("never matches a playlist or radio session", () => {
    expect(visitAlreadyInLatestPlay({ name: "Blue", entityKind: "album" }, [session({ source: "playlist" })])).toBe(false);
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
