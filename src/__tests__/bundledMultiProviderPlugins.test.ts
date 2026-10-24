// The bundled Artwork and Lyrics plugins each offer several providers. A
// provider the manifest declares but the code never registers would sit in
// Settings → Providers answering "no handler" forever; one registered but not
// declared would never be asked. Load each plugin the way the loader does
// (a function body returning { activate }) and hold the two lists together —
// then drive a source through it and check the status panel tells the user
// which sources work and which fail.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlerKey } from "../utils/providerKey";
import type { PluginManifest } from "../types/plugin";

const PLUGINS_DIR = join(__dirname, "../../src-tauri/plugins");

type Handler = (...args: unknown[]) => Promise<unknown>;
type Row = { id: string; title: string; subtitle?: string; badge?: { label: string; variant?: string } };
type SourceStats = {
  source: string;
  entity: string;
  nothing: number;
  rejected: { total: number; byReason: Record<string, number>; last: { got: string | null } | null };
  failed: { total: number; byKind: Record<string, number> };
};
type ViewNode = { type: string; items?: Row[]; children?: ViewNode[] };

function load(id: string, fetch: (url: string) => Promise<unknown>) {
  const manifest = JSON.parse(readFileSync(join(PLUGINS_DIR, id, "manifest.json"), "utf8")) as PluginManifest;
  const code = readFileSync(join(PLUGINS_DIR, id, "index.js"), "utf8");
  const handlers = new Map<string, Handler>();
  const images: string[] = [];
  const info: string[] = [];
  const tools: string[] = [];
  const toolHandlers = new Map<string, Handler>();
  const actions = new Map<string, () => void>();
  const views = new Map<string, ViewNode>();
  const logs: string[] = [];
  const api = {
    imageProviders: {
      onFetch: (entity: string, h: Handler, opts?: { provider?: string }) => {
        images.push(handlerKey(entity, opts?.provider));
        handlers.set(handlerKey(entity, opts?.provider), h);
      },
    },
    informationTypes: {
      onFetch: (typeId: string, h: Handler, opts?: { provider?: string }) => {
        info.push(handlerKey(typeId, opts?.provider));
        handlers.set(handlerKey(typeId, opts?.provider), h);
      },
    },
    assistant: { onTool: (name: string, h: Handler) => { tools.push(name); toolHandlers.set(name, h); } },
    network: { fetch },
    ui: {
      setViewData: (viewId: string, data: ViewNode) => { views.set(viewId, data); },
      onAction: (actionId: string, h: () => void) => { actions.set(actionId, h); },
    },
    storage: { get: () => Promise.resolve(null), set: () => Promise.resolve() },
    log: (_level: string, message: string) => { logs.push(message); },
  };
  const factory = new Function("api", "window", "globalThis", "self", "document", code);
  const exports = factory(api, globalThis, globalThis, globalThis, undefined) as { activate: (a: unknown) => void };
  exports.activate(api);
  return { manifest, images, info, tools, toolHandlers, handlers, actions, views, logs };
}

const noNetwork = () => Promise.reject(new Error("no network in tests"));

/** The rows of the panel's first list: one per source. */
function sourceRows(view: ViewNode | undefined): Row[] {
  const list = view?.children?.find((n) => n.type === "track-row-list");
  return list?.items ?? [];
}

describe.each(["artwork", "lyrics"])("bundled %s plugin", (id) => {
  const { manifest, images, info, tools } = load(id, noNetwork);
  const c = manifest.contributes ?? {};
  const declaredProviders = new Set((c.providers ?? []).map((p) => p.id));

  it("registers exactly the providers its manifest declares", () => {
    expect(images.sort()).toEqual((c.imageProviders ?? []).map((ip) => handlerKey(ip.entity, ip.provider)).sort());
    expect(info.sort()).toEqual((c.informationTypes ?? []).map((it) => handlerKey(it.id, it.provider)).sort());
  });

  it("names a declared provider on every entry", () => {
    for (const entry of [...(c.imageProviders ?? []), ...(c.informationTypes ?? [])]) {
      expect(entry.provider && declaredProviders.has(entry.provider)).toBe(true);
    }
  });

  it("registers a handler for every assistant tool it declares", () => {
    expect(tools.sort()).toEqual((c.assistant?.tools ?? []).map((t) => t.name).sort());
  });
});

describe("status panels", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("Artwork shows a failing source as Failing, with the reason, and logs it", async () => {
    const p = load("artwork", (url) =>
      url.includes("deezer")
        ? Promise.resolve({ status: 403, json: () => Promise.resolve({}) })
        : Promise.resolve({ status: 200, json: () => Promise.resolve({ artists: [{ strArtist: "Björk", strArtistThumb: "https://x/b.jpg" }] }) }),
    );
    expect(sourceRows(p.views.get("artwork-status")).every((r) => r.badge?.label === "Not asked yet")).toBe(true);

    await expect(p.handlers.get(handlerKey("artist", "deezer"))!("Björk")).rejects.toThrow("HTTP 403 from api.deezer.com");
    await expect(p.handlers.get(handlerKey("artist", "audiodb"))!("Bjork")).resolves.toMatchObject({ status: "ok" });
    await vi.advanceTimersByTimeAsync(1100);

    const rows = sourceRows(p.views.get("artwork-status"));
    const deezer = rows.find((r) => r.id === "deezer:artist")!;
    expect(deezer.badge).toEqual({ label: "Failing", variant: "error" });
    expect(deezer.subtitle).toContain("HTTP 403 from api.deezer.com");
    expect(rows.find((r) => r.id === "audiodb:artist")!.badge?.label).toBe("Working");
    expect(p.logs.some((l) => l.includes("Deezer") && l.includes("HTTP 403"))).toBe(true);
  });

  it("Artwork counts a hit thrown away by the name gate as rejected, not nothing, and hides it from the host", async () => {
    const p = load("artwork", () =>
      Promise.resolve({ status: 200, json: () => Promise.resolve({ data: [{ name: "Spice Girls", picture_xl: "https://e-cdns-images.dzcdn.net/images/artist/abc123/1000x1000.jpg" }] }) }),
    );
    const answer = await p.handlers.get(handlerKey("artist", "deezer"))!("Girls");
    expect(answer).toEqual({ status: "not_found" });
    await vi.advanceTimersByTimeAsync(1100);

    const deezer = sourceRows(p.views.get("artwork-status")).find((r) => r.id === "deezer:artist")!;
    expect(deezer.subtitle).toContain("0 nothing · 1 rejected");
    expect(deezer.subtitle).toContain("“Spice Girls”");
    const stats = (await p.toolHandlers.get("source_stats")!({})) as { sources: SourceStats[] };
    const row = stats.sources.find((s) => s.source === "deezer" && s.entity === "artist")!;
    expect(row.nothing).toBe(0);
    expect(row.rejected).toMatchObject({ total: 1, byReason: { name: 1 }, last: { got: "Spice Girls" } });
  });

  it("Artwork counts failures by kind", async () => {
    const p = load("artwork", (url) =>
      url.includes("deezer")
        ? Promise.resolve({ status: 429, json: () => Promise.resolve({}) })
        : Promise.reject(new Error("error sending request: operation timed out")),
    );
    await expect(p.handlers.get(handlerKey("artist", "deezer"))!("Björk")).rejects.toThrow("HTTP 429");
    await expect(p.handlers.get(handlerKey("album", "itunes"))!("Homogenic", "Björk")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1100);

    const rows = sourceRows(p.views.get("artwork-status"));
    expect(rows.find((r) => r.id === "deezer:artist")!.subtitle).toContain("1 failed (1 rate limited)");
    expect(rows.find((r) => r.id === "itunes:album")!.subtitle).toContain("1 failed (1 timed out)");
    const stats = (await p.toolHandlers.get("source_stats")!({})) as { sources: SourceStats[] };
    expect(stats.sources.find((s) => s.source === "deezer" && s.entity === "artist")!.failed).toMatchObject({ total: 1, byKind: { rate_limited: 1 } });
    expect(stats.sources.find((s) => s.source === "itunes")!.failed).toMatchObject({ total: 1, byKind: { timeout: 1 } });
  });

  it("Lyrics turns a failure into an error answer the chain moves past, and reports it", async () => {
    const p = load("lyrics", () => Promise.reject(new Error("offline")));
    const answer = await p.handlers.get(handlerKey("lyrics", "lrclib"))!({ kind: "track", id: 0, name: "Song", artistName: "Band" });
    expect(answer).toMatchObject({ status: "error", message: "offline" });
    await vi.advanceTimersByTimeAsync(1100);

    const lrclib = sourceRows(p.views.get("lyrics-status")).find((r) => r.id === "lrclib")!;
    expect(lrclib.badge?.label).toBe("Failing");
    expect(lrclib.subtitle).toContain("offline");
    expect(p.logs.some((l) => l.includes("LRCLIB") && l.includes("offline"))).toBe(true);
  });

  it("Test all sources asks every source with the test item and marks each row", async () => {
    const asked: string[] = [];
    const p = load("lyrics", (url) => {
      asked.push(url);
      return Promise.resolve({ status: 404, json: () => Promise.resolve({}) });
    });
    p.actions.get("lyrics-test")!();
    await vi.runAllTimersAsync();
    // LRCLIB's exact lookup misses, so it also searches; then Lyrics.ovh.
    expect(asked).toHaveLength(3);
    expect(asked.every((u) => u.includes("Radiohead"))).toBe(true);
    const rows = sourceRows(p.views.get("lyrics-status"));
    expect(rows.map((r) => r.badge?.label)).toEqual(["No match", "No match"]);
  });
});

describe("LRCLIB lookup", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  type Row = { trackName: string; artistName: string; duration?: number; syncedLyrics?: string | null; plainLyrics?: string | null; instrumental?: boolean };
  const ok = (body: unknown) => Promise.resolve({ status: 200, json: () => Promise.resolve(body) });
  const notFound = () => Promise.resolve({ status: 404, json: () => Promise.resolve({}) });

  /** Exact `get` answers `exact` (null = 404); `search` answers `rows` ("error" = HTTP 500). */
  function lrclib(exact: Row | null, rows: Row[] | "error") {
    const asked: string[] = [];
    const p = load("lyrics", (url) => {
      asked.push(url);
      if (url.includes("/api/get")) return exact ? ok(exact) : notFound();
      if (url.includes("/api/search")) {
        return rows === "error" ? Promise.resolve({ status: 500, json: () => Promise.resolve({}) }) : ok(rows);
      }
      return notFound();
    });
    const fetch = (entity: Record<string, unknown>) =>
      p.handlers.get(handlerKey("lyrics", "lrclib"))!({ kind: "track", id: 0, ...entity }) as Promise<{ status: string; value?: { text: string; kind: string } }>;
    return { p, asked, fetch };
  }

  it("sends the song's length, to a tenth of a second, when it is known", async () => {
    const { asked, fetch } = lrclib({ trackName: "Song", artistName: "Band", syncedLyrics: "[00:01.00] hi" }, []);
    const answer = await fetch({ name: "Song", artistName: "Band", durationSecs: 241.6 });
    expect(asked[0]).toContain("&duration=241.6");
    expect(answer).toEqual({ status: "ok", value: expect.objectContaining({ kind: "synced" }) });
    expect(asked).toHaveLength(1);
  });

  it("sends no length when it isn't known", async () => {
    const { asked, fetch } = lrclib({ trackName: "Song", artistName: "Band", plainLyrics: "words" }, []);
    await fetch({ name: "Song", artistName: "Band" });
    expect(asked[0]).not.toContain("duration=");
  });

  it("hands the host only status and value", async () => {
    const { fetch } = lrclib(null, [{ trackName: "Song", artistName: "Band", duration: 200, plainLyrics: "words" }]);
    const answer = await fetch({ name: "Song", artistName: "Band", durationSecs: 200 });
    expect(Object.keys(answer).sort()).toEqual(["status", "value"]);
  });

  it("falls back to a search and takes the same song within the length window, synced first", async () => {
    const { asked, fetch } = lrclib(null, [
      { trackName: "Song (Remastered 2011)", artistName: "Band", duration: 201, plainLyrics: "plain" },
      { trackName: "Song", artistName: "Band", duration: 199, syncedLyrics: "[00:01.00] synced" },
      { trackName: "Song", artistName: "Band", duration: 260, syncedLyrics: "[00:01.00] long cut" },
    ]);
    const answer = await fetch({ name: "Song", artistName: "Band", durationSecs: 200 });
    expect(asked[1]).toContain("/api/search?track_name=Song&artist_name=Band");
    expect(answer.value).toMatchObject({ kind: "synced", text: "[00:01.00] synced" });
  });

  it("refuses a search row with a different title, another artist or the wrong length", async () => {
    const { fetch } = lrclib(null, [
      { trackName: "Song Two", artistName: "Band", duration: 200, syncedLyrics: "x" },
      { trackName: "Song", artistName: "Other Band Entirely", duration: 200, syncedLyrics: "x" },
      { trackName: "Song", artistName: "Band", duration: 230, syncedLyrics: "x" },
      { trackName: "Song", artistName: "Band", duration: 200, instrumental: true },
    ]);
    expect(await fetch({ name: "Song", artistName: "Band", durationSecs: 200 })).toEqual({ status: "not_found" });
  });

  it("searches for the title without its decorations", async () => {
    const { asked, fetch } = lrclib(null, [{ trackName: "Song", artistName: "Band", duration: 200, syncedLyrics: "x" }]);
    const answer = await fetch({ name: "Song (Remastered 2011) - Single Version", artistName: "Band", durationSecs: 200 });
    expect(asked[0]).toContain("track_name=Song%20(Remastered%202011)%20-%20Single%20Version");
    expect(asked[1]).toContain("/api/search?track_name=Song&artist_name=Band");
    expect(answer.status).toBe("ok");
  });

  it("accepts our artist inside a collaboration credit", async () => {
    const { fetch } = lrclib(null, [{ trackName: "Song", artistName: "Band & Guest", duration: 200, plainLyrics: "words" }]);
    expect((await fetch({ name: "Song", artistName: "Band", durationSecs: 200 })).status).toBe("ok");
  });

  it("matches across accents, case and decorations", async () => {
    const { fetch } = lrclib(null, [{ trackName: "jóga", artistName: "Björk", duration: 305, plainLyrics: "words" }]);
    const answer = await fetch({ name: "Joga (Live) - 2002 Remaster", artistName: "BJORK", durationSecs: 304 });
    expect(answer.status).toBe("ok");
  });

  it("doesn't search after an exact hit flagged instrumental", async () => {
    const { asked, fetch } = lrclib({ trackName: "Song", artistName: "Band", instrumental: true }, [
      { trackName: "Song", artistName: "Band", duration: 200, syncedLyrics: "x" },
    ]);
    expect(await fetch({ name: "Song", artistName: "Band", durationSecs: 200 })).toEqual({ status: "not_found" });
    expect(asked).toHaveLength(1);
  });

  it("searches when the exact hit has no lyrics and isn't instrumental", async () => {
    // LRCLIB's get returns the oldest matching row, which may have no lyrics.
    const { asked, fetch } = lrclib({ trackName: "Song", artistName: "Band", syncedLyrics: null, plainLyrics: null }, [
      { trackName: "Song", artistName: "Band", duration: 200, syncedLyrics: "[00:01.00] found" },
    ]);
    const answer = await fetch({ name: "Song", artistName: "Band", durationSecs: 200 });
    expect(asked).toHaveLength(2);
    expect(answer.value).toMatchObject({ kind: "synced", text: "[00:01.00] found" });
  });

  it("without a known length, takes only the words of a search hit", async () => {
    const { fetch } = lrclib(null, [{ trackName: "Song (Live)", artistName: "Band", duration: 260, syncedLyrics: "[00:01.00] a", plainLyrics: "a" }]);
    expect((await fetch({ name: "Song", artistName: "Band" })).value).toMatchObject({ kind: "plain", text: "a" });
  });

  it("without a known length, strips the timing off a synced-only search hit", async () => {
    const { fetch } = lrclib(null, [{ trackName: "Song", artistName: "Band", duration: 200, syncedLyrics: "[00:01.00] one\n[00:02.50][00:09.00] two\n", plainLyrics: null }]);
    const answer = await fetch({ name: "Song", artistName: "Band" });
    expect(answer.value).toMatchObject({ kind: "plain" });
    expect(answer.value!.text.trim()).toBe("one\ntwo");
  });

  it("prefers the row carrying our title as written over a closer length", async () => {
    const { fetch } = lrclib(null, [
      { trackName: "Song", artistName: "Band", duration: 200, syncedLyrics: "[00:01.00] studio" },
      { trackName: "Song (Live)", artistName: "Band", duration: 201.5, syncedLyrics: "[00:01.00] live" },
    ]);
    expect((await fetch({ name: "Song (Live)", artistName: "Band", durationSecs: 200 })).value).toMatchObject({ text: "[00:01.00] live" });
  });

  it("counts a failed search as a search, and says the search failed", async () => {
    const { p, fetch } = lrclib(null, "error");
    const answer = await fetch({ name: "Song", artistName: "Band", durationSecs: 200 });
    expect(answer.status).toBe("error");
    await vi.runAllTimersAsync();
    const view = p.views.get("lyrics-status");
    expect(sourceRows(view).find((r) => r.id === "lrclib")!.subtitle).toContain("1 searched after no exact match, 0 found that way");
    const recent = view?.children?.find((n) => n.type === "section")?.children?.[0]?.items ?? [];
    expect(recent[0].subtitle).toContain("search failed — HTTP 500 from lrclib.net");
  });

  it("counts lookups with a length, searches, and finds by search on the status panel", async () => {
    const { p, fetch } = lrclib(null, [{ trackName: "Song", artistName: "Band", duration: 200, syncedLyrics: "x" }]);
    await fetch({ name: "Song", artistName: "Band", durationSecs: 200 });
    await fetch({ name: "Missing", artistName: "Band" });
    await vi.runAllTimersAsync();
    const view = p.views.get("lyrics-status");
    const lrclibRow = sourceRows(view).find((r) => r.id === "lrclib")!;
    expect(lrclibRow.subtitle).toContain("1 of 2 with the song's length");
    expect(lrclibRow.subtitle).toContain("2 searched after no exact match, 1 found that way");
    const recent = view?.children?.find((n) => n.type === "section")?.children?.[0]?.items ?? [];
    expect(recent.some((r) => r.subtitle?.includes("via search, as “Song” – Band"))).toBe(true);
  });
});
