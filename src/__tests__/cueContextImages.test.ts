import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../utils/infoFetchChain", () => ({ fetchInfoValue: vi.fn(), resolveInfoEntityId: vi.fn(async () => undefined) }));
vi.mock("../hooks/useNowPlayingInfo", () => ({ resolveTrackQuality: vi.fn(async () => null) }));

import { invoke } from "@tauri-apps/api/core";
import { fetchInfoValue } from "../utils/infoFetchChain";
import { contextImageTypeIds, gatherCueContext } from "../utils/cueContext";
import type { QueueTrack } from "../types";

const mockInvoke = vi.mocked(invoke);
const mockFetch = vi.mocked(fetchInfoValue);

const track = { key: "q:1", title: "Song", artist_name: "Band", album_title: "Record", duration_secs: 200 } as QueueTrack;

// [type_id, name, display_kind, ttl, order, providers, entity]
const TYPES: Record<string, unknown[][]> = {
  track: [],
  artist: [
    ["artist_photos", "Photos", "image_gallery", 0, 0, [], "artist"],
    ["getty_photos", "Getty Images", "plugin_view", 0, 1, [], "artist"],
    ["community_artist", "Community", "plugin_view", 0, 2, [], "artist"],
  ],
  album: [],
};

const ok = (displayKind: string, value: unknown, name = "x") =>
  ({ status: "ok", displayKind, value, name }) as unknown as Awaited<ReturnType<typeof fetchInfoValue>>;

const gather = (imageTypeIds?: Set<string>) =>
  gatherCueContext({ track, isPlaying: false, invokeInfoFetch: vi.fn(), deadlineMs: 200, imageTypeIds });

describe("cue context images from flagged info types", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "info_get_types_for_entity") return TYPES[(args as { entity: string }).entity] ?? [];
      return null;
    });
    mockFetch.mockReset();
    mockFetch.mockImplementation(async ({ typeId }) => {
      if (typeId === "artist_photos") {
        return ok("image_gallery", { images: [{ url: "https://commons.example/a.jpg", author: "A", license: "CC BY-SA" }] }, "Photos");
      }
      if (typeId === "getty_photos") {
        return ok("plugin_view", {
          view: { type: "text", content: "tab" },
          images: [
            { url: "https://media.gettyimages.com/id/1/x.jpg?s=612x612", caption: "Live, 1995", author: "Paul Natkin", source: "Getty Images / Archive Photos", pageUrl: "https://www.gettyimages.com/detail/1" },
            { url: "http://insecure.example/x.jpg" },
          ],
        }, "Getty Images");
      }
      return ok("plugin_view", { view: { type: "text", content: "community" } }, "Community");
    });
  });

  it("a plugin_view type flagged contextImages adds its gallery; unflagged ones are never fetched", async () => {
    const ctx = await gather(new Set(["getty_photos"]));
    expect(ctx.images.map((g) => g.typeId)).toEqual(["artist_photos", "getty_photos"]);
    const getty = ctx.images.find((g) => g.typeId === "getty_photos")!;
    expect(getty.images).toEqual([
      { url: "https://media.gettyimages.com/id/1/x.jpg?s=612x612", caption: "Live, 1995", author: "Paul Natkin", source: "Getty Images / Archive Photos", pageUrl: "https://www.gettyimages.com/detail/1" },
    ]);
    const fetched = mockFetch.mock.calls.map(([a]) => a.typeId);
    expect(fetched).not.toContain("community_artist");
  });

  it("without the flag a plugin_view tab is left out, as before", async () => {
    const ctx = await gather();
    expect(ctx.images.map((g) => g.typeId)).toEqual(["artist_photos"]);
    expect(mockFetch.mock.calls.map(([a]) => a.typeId)).not.toContain("getty_photos");
  });

  it("contextImageTypeIds reads only types that set contextImages: true", () => {
    const ids = contextImageTypeIds([
      { manifest: { contributes: { informationTypes: [{ id: "getty_photos", contextImages: true }, { id: "other" }] } } },
      { manifest: {} },
    ]);
    expect([...ids]).toEqual(["getty_photos"]);
  });
});
