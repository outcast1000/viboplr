import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../utils/infoFetchChain", () => ({ fetchInfoValue: vi.fn(), resolveInfoEntityId: vi.fn(async () => undefined) }));
vi.mock("../hooks/useNowPlayingInfo", () => ({ resolveTrackQuality: vi.fn(async () => "FLAC") }));

import { invoke } from "@tauri-apps/api/core";
import { fetchInfoValue } from "../utils/infoFetchChain";
import { CUE_PENDING_NOTE, gatherCueContext } from "../utils/cueContext";
import type { QueueTrack } from "../types";

const mockInvoke = vi.mocked(invoke);
const mockFetch = vi.mocked(fetchInfoValue);

const track = { key: "q:1", title: "Song", artist_name: "Band", album_title: "Record", duration_secs: 200 } as QueueTrack;

// [type_id, name, display_kind, ttl, order, providers, entity]
const TYPES: Record<string, unknown[][]> = {
  track: [["song_bio", "Song Bio", "rich_text", 0, 0, [], "track"], ["lyrics_meaning", "Meaning", "rich_text", 0, 1, [], "track"]],
  artist: [["artist_bio", "About", "rich_text", 0, 0, [], "artist"]],
  album: [],
};

const ok = (displayKind: string, value: unknown, name = "x") =>
  ({ status: "ok", displayKind, value, name }) as unknown as Awaited<ReturnType<typeof fetchInfoValue>>;
const never = () => new Promise<never>(() => {});

const gather = () => gatherCueContext({ track, isPlaying: false, invokeInfoFetch: vi.fn(), deadlineMs: 30 });

describe("gatherCueContext deadline", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "info_get_types_for_entity") return TYPES[(args as { entity: string }).entity] ?? [];
      return null;
    });
    mockFetch.mockReset();
  });

  it("answers with what arrived and lists the slow values as pending, with their fetch arguments", async () => {
    mockFetch.mockImplementation(async ({ typeId }) => {
      if (typeId === "lyrics") return ok("lyrics", { kind: "plain", text: "la la" });
      if (typeId === "song_bio") return ok("rich_text", { full: "A song." }, "Song Bio");
      return never(); // lyrics_meaning and artist_bio hang
    });

    const ctx = await gather();

    expect(ctx.lyrics).toEqual({ kind: "plain", text: "la la" });
    expect(ctx.prose.map((p) => p.typeId)).toEqual(["song_bio"]);
    expect(ctx.track.quality).toBe("FLAC");
    expect(ctx.pending).toEqual([
      { about: "song", typeId: "lyrics_meaning", name: "Meaning", fetch: { kind: "track", title: "Song", artistName: "Band", typeId: "lyrics_meaning" } },
      { about: "artist", typeId: "artist_bio", name: "About", fetch: { kind: "artist", name: "Band", typeId: "artist_bio" } },
    ]);
    expect(ctx.pendingNote).toBe(CUE_PENDING_NOTE);
  });

  it("lists hung lyrics as pending and still returns the guide and styles", async () => {
    mockFetch.mockImplementation(async ({ typeId }) => (typeId === "lyrics" ? never() : ok("rich_text", { full: "Text." })));

    const ctx = await gather();

    expect(ctx.lyrics).toBeNull();
    expect(ctx.pending).toEqual([
      { about: "song", typeId: "lyrics", name: "Lyrics", fetch: { kind: "track", title: "Song", artistName: "Band", typeId: "lyrics" } },
    ]);
    expect(ctx.guide).toBeTruthy();
    expect(ctx.styles.length).toBeGreaterThan(0);
  });

  it("has an empty pending list and no note when everything arrives", async () => {
    mockFetch.mockImplementation(async () => ok("rich_text", { full: "Text." }));

    const ctx = await gather();

    expect(ctx.pending).toEqual([]);
    expect(ctx).not.toHaveProperty("pendingNote");
    expect(ctx.prose).toHaveLength(3);
  });

  it("does not wait on a hung quality probe", async () => {
    const { resolveTrackQuality } = await import("../hooks/useNowPlayingInfo");
    vi.mocked(resolveTrackQuality).mockImplementationOnce(never);
    mockFetch.mockImplementation(async () => ok("rich_text", { full: "Text." }));

    const ctx = await gather();

    expect(ctx.track.quality).toBeNull();
    expect(ctx.pending).toEqual([]);
  });
});
