// `fetchInfoValue` is the one operation behind the control API's info.fetch
// and a plugin's api.informationTypes.fetch. These pin the contract both
// callers rely on: fresh cache is served without touching a provider, a
// stale/missing value walks the chain and lands in the cache, `pluginId` pins
// (and skips the cache), `force` re-walks, and a bad request throws while a
// failing provider merely reports.
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  fetchInfoValue,
  saveInfoValue,
  resolveInfoEntityId,
  InfoFetchRequestError,
  type InfoTypeRow,
  type InfoValueRow,
} from "../utils/infoFetchChain";
import { buildEntityKey, type InfoEntity, type InfoFetchResult } from "../types/informationTypes";
import { onInfoValueChanged } from "../utils/infoValueEvents";

const NOW = Math.floor(Date.now() / 1000);
const TTL = 7_776_000; // 90 days, like album_wiki

const album: InfoEntity = { kind: "album", name: "Blue", id: 7, artistName: "Joni Mitchell" };

// album_wiki with two providers, Last.fm (integer row 11) first, then a
// hypothetical second (row 12).
const albumWikiRow: InfoTypeRow = ["album_wiki", "Review", "rich_text", TTL, 0, [["lastfm", 11], ["other", 12]], ""];

function setupBackend(opts: { types?: InfoTypeRow[]; values?: InfoValueRow[] } = {}) {
  const upserts: Array<Record<string, unknown>> = [];
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "info_get_types_for_entity": return opts.types ?? [albumWikiRow];
      case "info_get_values_for_entity": return opts.values ?? [];
      case "info_upsert_value": upserts.push(args ?? {}); return null;
      case "info_delete_value": return null;
      default: throw new Error(`unexpected invoke ${cmd}`);
    }
  });
  return { upserts };
}

function providerReturning(results: Record<string, InfoFetchResult>) {
  return vi.fn(async (pluginId: string): Promise<InfoFetchResult> => results[pluginId] ?? { status: "not_found" });
}

beforeEach(() => {
  invoke.mockReset();
});

describe("fetchInfoValue", () => {
  it("serves a fresh cached value without calling any provider", async () => {
    setupBackend({ values: [[11, "album_wiki", JSON.stringify({ summary: "cached" }), "ok", NOW - 60]] });
    const fetch = providerReturning({});
    const out = await fetchInfoValue({ typeId: "album_wiki", entity: album, invokeInfoFetch: fetch });
    expect(out).toMatchObject({ typeId: "album_wiki", name: "Review", displayKind: "rich_text", status: "ok", source: "cache" });
    expect(out.value).toEqual({ summary: "cached" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("walks the chain in order when nothing is cached and writes the winner to the cache", async () => {
    const { upserts } = setupBackend();
    const fetch = providerReturning({ lastfm: { status: "not_found" }, other: { status: "ok", value: { summary: "from other" } } });
    const out = await fetchInfoValue({ typeId: "album_wiki", entity: album, invokeInfoFetch: fetch });
    expect(out).toMatchObject({ status: "ok", source: "fetch", value: { summary: "from other" } });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["lastfm", "other"]);
    // Persisted under the winning provider's row so the detail page reads it next.
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ informationTypeId: 12, status: "ok" });
  });

  it("refetches a stale ok value", async () => {
    setupBackend({ values: [[11, "album_wiki", JSON.stringify({ summary: "old" }), "ok", NOW - TTL - 1]] });
    const fetch = providerReturning({ lastfm: { status: "ok", value: { summary: "new" } } });
    const out = await fetchInfoValue({ typeId: "album_wiki", entity: album, invokeInfoFetch: fetch });
    expect(out).toMatchObject({ source: "fetch", value: { summary: "new" } });
  });

  it("a cached not_found is never served as a value — the chain is asked again", async () => {
    // Only an ok row counts as a cache serve (`render`). A miss, fresh or
    // stale, re-walks the chain and reports the providers' current answer,
    // which is the same rule the control API's info.fetch has always applied.
    setupBackend({ values: [[11, "album_wiki", "{}", "not_found", NOW - 60]] });
    const fetch = providerReturning({});
    const out = await fetchInfoValue({ typeId: "album_wiki", entity: album, invokeInfoFetch: fetch });
    expect(out).toMatchObject({ status: "not_found", source: "fetch", value: null });
    expect(fetch).toHaveBeenCalled();
  });

  it("force re-walks the chain even when the cache is fresh", async () => {
    setupBackend({ values: [[11, "album_wiki", JSON.stringify({ summary: "cached" }), "ok", NOW - 60]] });
    const fetch = providerReturning({ lastfm: { status: "ok", value: { summary: "fresh" } } });
    const out = await fetchInfoValue({ typeId: "album_wiki", entity: album, invokeInfoFetch: fetch, force: true });
    expect(out).toMatchObject({ source: "fetch", value: { summary: "fresh" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("pluginId pins one provider and bypasses the cache serve", async () => {
    setupBackend({ values: [[11, "album_wiki", JSON.stringify({ summary: "lastfm cached" }), "ok", NOW - 60]] });
    const fetch = providerReturning({ other: { status: "ok", value: { summary: "other's answer" } } });
    const out = await fetchInfoValue({ typeId: "album_wiki", entity: album, invokeInfoFetch: fetch, pluginId: "other" });
    expect(out).toMatchObject({ source: "fetch", value: { summary: "other's answer" } });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["other"]);
  });

  it("a pinned write drops the other providers' rows, so the entity has one value", async () => {
    // Before, cleanup only walked the pinned chain: Last.fm's row stayed next
    // to the new one and readers kept whichever their map met last.
    const deletes: Array<Record<string, unknown>> = [];
    setupBackend({ values: [[11, "album_wiki", JSON.stringify({ summary: "lastfm" }), "ok", NOW - 60]] });
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "info_delete_value") deletes.push(args ?? {});
      return base(cmd, args);
    });
    await fetchInfoValue({
      typeId: "album_wiki", entity: album, pluginId: "other",
      invokeInfoFetch: providerReturning({ other: { status: "ok", value: { summary: "other" } } }),
    });
    expect(deletes).toEqual([expect.objectContaining({ informationTypeId: 11 })]);
  });

  it("announces a write so open views re-read, and stays quiet on a cache serve", async () => {
    const seen: Array<[string, string]> = [];
    const off = onInfoValueChanged((key, type) => seen.push([key, type]));
    try {
      setupBackend({ values: [[11, "album_wiki", JSON.stringify({ summary: "cached" }), "ok", NOW - 60]] });
      await fetchInfoValue({ typeId: "album_wiki", entity: album, invokeInfoFetch: providerReturning({}) });
      expect(seen).toEqual([]);
      await fetchInfoValue({ typeId: "album_wiki", entity: album, invokeInfoFetch: providerReturning({}), force: true });
      expect(seen).toEqual([[buildEntityKey(album), "album_wiki"]]);
    } finally {
      off();
    }
  });

  it("a provider failure is reported as status error, never thrown", async () => {
    setupBackend();
    const fetch = vi.fn(async (): Promise<InfoFetchResult> => { throw new Error("network down"); });
    const out = await fetchInfoValue({ typeId: "album_wiki", entity: album, invokeInfoFetch: fetch });
    expect(out).toMatchObject({ status: "error", source: "fetch", value: null });
  });

  it("throws InfoFetchRequestError for an unknown type, naming the available ones", async () => {
    setupBackend();
    await expect(
      fetchInfoValue({ typeId: "nope", entity: album, invokeInfoFetch: providerReturning({}) }),
    ).rejects.toMatchObject({ name: "InfoFetchRequestError", message: expect.stringContaining("album_wiki") });
  });

  it("throws InfoFetchRequestError when the pinned plugin is not a provider", async () => {
    setupBackend();
    const err = await fetchInfoValue({ typeId: "album_wiki", entity: album, invokeInfoFetch: providerReturning({}), pluginId: "genius" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfoFetchRequestError);
    expect((err as Error).message).toContain("lastfm");
  });

  it("throws InfoFetchRequestError when the type has no providers at all", async () => {
    setupBackend({ types: [["album_wiki", "Review", "rich_text", TTL, 0, [], ""]] });
    await expect(
      fetchInfoValue({ typeId: "album_wiki", entity: album, invokeInfoFetch: providerReturning({}) }),
    ).rejects.toBeInstanceOf(InfoFetchRequestError);
  });
});

describe("fetchInfoValue — synced lyrics beat plain", () => {
  const song: InfoEntity = { kind: "track", name: "Jóga", id: 0, artistName: "Björk" };
  // Local files (row 20) first, then two web providers.
  const lyricsRow: InfoTypeRow = ["lyrics", "Lyrics", "lyrics", TTL, 0, [["core:local-lyrics", 20], ["lrclib", 21], ["lyrics-ovh", 22]], ""];
  const plain = (from: string) => ({ status: "ok" as const, value: { kind: "plain", text: `plain from ${from}` } });
  const synced = (from: string) => ({ status: "ok" as const, value: { kind: "synced", text: `[00:01.00]synced from ${from}` } });

  it("walks past plain local lyrics to a synced web answer and caches that one", async () => {
    const { upserts } = setupBackend({ types: [lyricsRow] });
    const fetch = providerReturning({ "core:local-lyrics": plain("file"), lrclib: synced("lrclib") });
    const out = await fetchInfoValue({ typeId: "lyrics", entity: song, invokeInfoFetch: fetch });
    expect(out.value).toMatchObject({ kind: "synced", text: "[00:01.00]synced from lrclib" });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["core:local-lyrics", "lrclib"]);
    expect(upserts).toEqual([expect.objectContaining({ informationTypeId: 21, status: "ok" })]);
  });

  it("keeps the first plain answer when nobody has synced", async () => {
    const { upserts } = setupBackend({ types: [lyricsRow] });
    const fetch = providerReturning({ "core:local-lyrics": plain("file"), "lyrics-ovh": plain("ovh") });
    const out = await fetchInfoValue({ typeId: "lyrics", entity: song, invokeInfoFetch: fetch });
    expect(out).toMatchObject({ status: "ok", value: { text: "plain from file" } });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(upserts).toEqual([expect.objectContaining({ informationTypeId: 20, status: "ok" })]);
  });

  it("stops at the first synced answer without asking further providers", async () => {
    setupBackend({ types: [lyricsRow] });
    const fetch = providerReturning({ "core:local-lyrics": synced("file"), lrclib: synced("lrclib") });
    const out = await fetchInfoValue({ typeId: "lyrics", entity: song, invokeInfoFetch: fetch });
    expect(out.value).toMatchObject({ text: "[00:01.00]synced from file" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("only lyrics are provisional — other types still stop at the first ok", async () => {
    setupBackend();
    const fetch = providerReturning({ lastfm: { status: "ok", value: { kind: "plain", summary: "x" } } });
    await fetchInfoValue({ typeId: "album_wiki", entity: album, invokeInfoFetch: fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("saveInfoValue — a value put in place by hand", () => {
  const song: InfoEntity = { kind: "track", name: "Jóga", id: 0, artistName: "Björk" };
  const lyricsRow: InfoTypeRow = ["lyrics", "Lyrics", "lyrics", TTL, 0, [["core:local-lyrics", 20], ["lrclib", 21], ["lyrics-ovh", 22]], ""];
  const lrc = { kind: "synced", text: "[00:01.00]shared" };

  function recordWrites(values: InfoValueRow[]) {
    const { upserts } = setupBackend({ types: [lyricsRow], values });
    const deletes: Array<Record<string, unknown>> = [];
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "info_delete_value") deletes.push(args ?? {});
      return base(cmd, args);
    });
    return { upserts, deletes };
  }

  it("with nothing cached, lands under the first web provider — never the daily-reprobed local row", async () => {
    const { upserts, deletes } = recordWrites([]);
    await saveInfoValue({ typeId: "lyrics", entity: song, value: lrc });
    expect(upserts).toEqual([expect.objectContaining({ informationTypeId: 21, status: "ok", value: JSON.stringify(lrc) })]);
    expect(deletes.map((d) => d.informationTypeId)).toEqual([20, 22]);
  });

  it("replaces a web provider's row in place, and a local row by moving off it", async () => {
    let w = recordWrites([[22, "lyrics", "{}", "ok", NOW - 60]]);
    await saveInfoValue({ typeId: "lyrics", entity: song, value: lrc });
    expect(w.upserts[0]).toMatchObject({ informationTypeId: 22 });

    w = recordWrites([[20, "lyrics", "{}", "ok", NOW - 60]]);
    await saveInfoValue({ typeId: "lyrics", entity: song, value: lrc });
    expect(w.upserts[0]).toMatchObject({ informationTypeId: 21 });
    expect(w.deletes.map((d) => d.informationTypeId)).toContain(20);
  });

  it("tells open views", async () => {
    recordWrites([]);
    const seen: string[] = [];
    const off = onInfoValueChanged((key) => seen.push(key));
    try {
      await saveInfoValue({ typeId: "lyrics", entity: song, value: lrc });
    } finally {
      off();
    }
    expect(seen).toEqual([buildEntityKey(song)]);
  });

  it("refuses a type with no providers", async () => {
    setupBackend({ types: [] });
    await expect(saveInfoValue({ typeId: "lyrics", entity: song, value: lrc })).rejects.toBeInstanceOf(InfoFetchRequestError);
  });
});

describe("resolveInfoEntityId", () => {
  it("looks an album up by title + artist and returns 0 when absent", async () => {
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "find_album_by_name") return args?.title === "Blue" ? { id: 42 } : null;
      throw new Error(`unexpected invoke ${cmd}`);
    });
    expect(await resolveInfoEntityId({ kind: "album", name: "Blue", artistName: "Joni Mitchell" })).toBe(42);
    expect(await resolveInfoEntityId({ kind: "album", name: "Other" })).toBe(0);
  });

  it("never throws — a failed lookup is 0 (not in library)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockImplementation(async () => { throw new Error("db closed"); });
    expect(await resolveInfoEntityId({ kind: "track", name: "x" })).toBe(0);
    spy.mockRestore();
  });
});
