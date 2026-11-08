import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../utils/trackGalleries", async (orig) => {
  const actual = await orig<typeof import("../utils/trackGalleries")>();
  return { ...actual, gatherTrackGalleries: vi.fn(async () => {}) };
});

import { invoke } from "@tauri-apps/api/core";
import { gatherTrackGalleries } from "../utils/trackGalleries";
import {
  clearContextImageCache,
  contextImageCredit,
  gatherContextImages,
  normalizeContextImageResult,
  rankContextImages,
  resolveTrackYear,
  trackContextRequest,
  typesSpokenForByProviders,
  CONTEXT_IMAGE_TIMEOUT_MS,
  type ContextImageBatch,
  type OrderedContextImageProvider,
} from "../utils/contextImages";
import type { ContextImageRequest, ContextImageResult } from "../types/plugin";
import type { QueueTrack } from "../types";

const mockInvoke = vi.mocked(invoke);
const track = { key: "q:1", title: "Glory Box", artist_name: "Portishead", album_title: "Dummy", duration_secs: 301 } as QueueTrack;

describe("normalizeContextImageResult", () => {
  it("keeps https pictures with web page links, clamps relevance, drops what isn't safe", () => {
    const out = normalizeContextImageResult({
      status: "ok",
      images: [
        { url: "https://x/1.jpg", pageUrl: "https://x/page", relevance: 3, year: 1994, about: "artist", reason: "  Taken   in 1994 " },
        { url: "http://x/insecure.jpg" },
        { url: "https://x/2.jpg", pageUrl: "file:///etc/passwd", relevance: -1, year: 3000, about: "planet" },
        { url: "https://x/1.jpg" },
        "nonsense",
      ],
    }, 10);
    expect(out).toEqual({
      status: "ok",
      images: [
        { url: "https://x/1.jpg", pageUrl: "https://x/page", relevance: 1, year: 1994, about: "artist", reason: "Taken in 1994" },
        { url: "https://x/2.jpg", relevance: 0 },
      ],
    });
  });

  it("trims to the limit, and reads nothing usable as not_found", () => {
    const many = { status: "ok", images: [{ url: "https://a/1" }, { url: "https://a/2" }, { url: "https://a/3" }] };
    expect((normalizeContextImageResult(many, 2) as { images: unknown[] }).images).toHaveLength(2);
    expect(normalizeContextImageResult({ status: "ok", images: [{ url: "ftp://x" }] }, 5)).toEqual({ status: "not_found" });
    expect(normalizeContextImageResult(null, 5)).toEqual({ status: "not_found" });
    expect(normalizeContextImageResult({ status: "error", message: "blocked" }, 5)).toEqual({ status: "error", message: "blocked" });
  });
});

describe("rankContextImages", () => {
  const b = (key: string, order: number, images: ContextImageBatch["images"]): ContextImageBatch =>
    ({ providerKey: key, providerName: key, order, images });

  it("puts the best fits first and labels each with its provider", () => {
    const out = rankContextImages([
      b("a", 0, [{ url: "https://a/1", relevance: 0.1 }]),
      b("b", 1, [{ url: "https://b/1", relevance: 0.8 }]),
    ]);
    expect(out.map((i) => [i.url, i.providerKey])).toEqual([["https://b/1", "b"], ["https://a/1", "a"]]);
  });

  it("an unrated picture counts as a middling fit", () => {
    const out = rankContextImages([b("a", 0, [{ url: "https://a/low", relevance: 0.3 }, { url: "https://a/none" }])]);
    expect(out.map((i) => i.url)).toEqual(["https://a/none", "https://a/low"]);
  });
});

describe("contextImageCredit", () => {
  it("names author, year and source once each", () => {
    expect(contextImageCredit({ author: "Jane", year: 1994, source: "Getty Images" })).toBe("Jane · 1994 · Getty Images");
    expect(contextImageCredit({ author: "Jane", source: "Jane · CC BY-SA 4.0" })).toBe("Jane · CC BY-SA 4.0");
    expect(contextImageCredit({ year: 1994, source: "Live, 1994" })).toBe("Live, 1994");
    expect(contextImageCredit({})).toBeNull();
  });
});

describe("resolveTrackYear", () => {
  beforeEach(() => mockInvoke.mockReset());

  it("reads the library copy's year", async () => {
    mockInvoke.mockImplementation(async (cmd) => (cmd === "find_track_by_metadata" ? { year: 1994 } : null));
    expect(await resolveTrackYear(track)).toBe(1994);
  });

  it("falls back to the album's year, and to null when nobody knows", async () => {
    mockInvoke.mockImplementation(async (cmd) => (cmd === "find_album_by_name" ? { year: 1995 } : { year: null }));
    expect(await resolveTrackYear(track)).toBe(1995);
    mockInvoke.mockImplementation(async () => null);
    expect(await resolveTrackYear(track)).toBeNull();
  });

  it("uses the entry's own library row when it has one", async () => {
    mockInvoke.mockImplementation(async (cmd, args) =>
      (cmd === "get_track_by_id" && (args as { trackId: number }).trackId === 7 ? { year: 1997 } : null));
    expect(await resolveTrackYear({ ...track, libraryId: 7 })).toBe(1997);
  });
});

describe("trackContextRequest", () => {
  it("tells the provider the track, its artist and album, the year and the purpose", () => {
    expect(trackContextRequest(track, 1994, "cue", 500)).toEqual({
      subject: "track",
      track: { title: "Glory Box", artistName: "Portishead", albumTitle: "Dummy", albumArtistName: "Portishead", year: 1994, durationSecs: 301 },
      artist: { name: "Portishead" },
      album: { title: "Dummy", artistName: "Portishead", year: 1994 },
      purpose: "cue",
      limit: 60,
    });
  });
});

describe("typesSpokenForByProviders", () => {
  it("lists the info types of plugins that declare a context-image provider", () => {
    expect([...typesSpokenForByProviders([
      { manifest: { contributes: { informationTypes: [{ id: "getty_photos" }], contextImageProviders: [{}] } } },
      { manifest: { contributes: { informationTypes: [{ id: "artist_photos" }] } } },
    ])]).toEqual(["getty_photos"]);
  });
});

describe("gatherContextImages", () => {
  const provider = (pluginId: string, enabled = true): OrderedContextImageProvider =>
    ({ pluginId, providerId: "era", name: pluginId, key: `${pluginId}:era`, enabled });

  beforeEach(() => {
    clearContextImageCache();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd) => (cmd === "find_track_by_metadata" ? { year: 1994 } : null));
    vi.mocked(gatherTrackGalleries).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const run = (providers: OrderedContextImageProvider[], invokeProvider: (p: string, i: string, r: ContextImageRequest) => Promise<ContextImageResult>) => {
    const batches: ContextImageBatch[] = [];
    const errors: string[] = [];
    const done = gatherContextImages({
      track, purpose: "nowplaying", limit: 20, providers, invokeProvider,
      onBatch: (b) => batches.push(b), onError: (n, m) => errors.push(`${n}: ${m}`),
    });
    return { done, batches, errors };
  };

  it("asks only switched-on providers, with the year, and reports each answer", async () => {
    const invokeProvider = vi.fn(async (pluginId: string, _providerId: string, _request: ContextImageRequest) => (pluginId === "commons"
      ? { status: "ok" as const, images: [{ url: "https://c/1.jpg" }] }
      : { status: "error" as const, message: "blocked" }));
    const { done, batches, errors } = run([provider("commons"), provider("getty"), provider("off", false)], invokeProvider);
    await done;
    expect(invokeProvider.mock.calls.map((c) => c[0])).toEqual(["commons", "getty"]);
    expect(invokeProvider.mock.calls[0]?.[2].track?.year).toBe(1994);
    expect(batches.map((b) => b.providerKey)).toEqual(["commons:era"]);
    expect(errors).toEqual(["getty: blocked"]);
  });

  it("remembers an answer for the session, so a replay asks nobody", async () => {
    const invokeProvider = vi.fn(async () => ({ status: "ok" as const, images: [{ url: "https://c/1.jpg" }] }));
    await run([provider("commons")], invokeProvider).done;
    const second = run([provider("commons")], invokeProvider);
    await second.done;
    expect(invokeProvider).toHaveBeenCalledTimes(1);
    expect(second.batches).toHaveLength(1);
  });

  it("a provider that never answers costs only itself", async () => {
    vi.useFakeTimers();
    const invokeProvider = vi.fn((pluginId: string) => (pluginId === "slow"
      ? new Promise<ContextImageResult>(() => {})
      : Promise.resolve({ status: "ok" as const, images: [{ url: "https://f/1.jpg" }] })));
    const { done, batches, errors } = run([provider("slow"), provider("fast")], invokeProvider);
    await vi.advanceTimersByTimeAsync(CONTEXT_IMAGE_TIMEOUT_MS + 10);
    await done;
    expect(batches.map((b) => b.providerKey)).toEqual(["fast:era"]);
    expect(errors).toEqual(["slow: timed out"]);
  });

  it("adapts the old galleries after the declared providers, leaving out what they speak for", async () => {
    vi.mocked(gatherTrackGalleries).mockImplementation(async (opts) => {
      opts.onGallery({ about: "artist", typeId: "artist_photos", name: "Photos", images: [{ url: "https://old/1.jpg" }] });
    });
    const batches: ContextImageBatch[] = [];
    await gatherContextImages({
      track, purpose: "nowplaying", limit: 20, providers: [provider("getty")],
      invokeProvider: async () => ({ status: "not_found" }),
      legacy: { invokeInfoFetch: vi.fn(), excludeTypeIds: new Set(["getty_photos"]) },
      onBatch: (b) => batches.push(b),
    });
    expect(vi.mocked(gatherTrackGalleries).mock.calls[0][0].excludeTypeIds).toEqual(new Set(["getty_photos"]));
    expect(batches).toEqual([{
      providerKey: "gallery:artist_photos", providerName: "Photos", order: 2,
      images: [{ url: "https://old/1.jpg", about: "artist" }],
    }]);
  });
});
