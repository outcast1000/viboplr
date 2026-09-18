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
  resolveInfoEntityId,
  InfoFetchRequestError,
  type InfoTypeRow,
  type InfoValueRow,
} from "../utils/infoFetchChain";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";

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
