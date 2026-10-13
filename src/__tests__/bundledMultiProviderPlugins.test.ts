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
type ViewNode = { type: string; items?: Row[]; children?: ViewNode[] };

function load(id: string, fetch: (url: string) => Promise<unknown>) {
  const manifest = JSON.parse(readFileSync(join(PLUGINS_DIR, id, "manifest.json"), "utf8")) as PluginManifest;
  const code = readFileSync(join(PLUGINS_DIR, id, "index.js"), "utf8");
  const handlers = new Map<string, Handler>();
  const images: string[] = [];
  const info: string[] = [];
  const tools: string[] = [];
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
    assistant: { onTool: (name: string) => { tools.push(name); } },
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
  return { manifest, images, info, tools, handlers, actions, views, logs };
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
    expect(asked).toHaveLength(2);
    expect(asked.every((u) => u.includes("Radiohead"))).toBe(true);
    const rows = sourceRows(p.views.get("lyrics-status"));
    expect(rows.map((r) => r.badge?.label)).toEqual(["No match", "No match"]);
  });
});
