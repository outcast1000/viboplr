import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The subsonic-browse plugin is standalone ES5 executed by the host via
// `new Function("api", code)`. There's no plugin test harness in the repo, so
// we mock the `api` surface, drive activate(), capture the emitted view tree +
// playback calls, and assert on the pure logic we built: cross-server dedup,
// per-server count flags, relevance sort, resilience, and stream failover.

const PLUGIN_CODE = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src-tauri/plugins/subsonic-browse/index.js"),
  "utf8",
);

type Any = Record<string, any>;

const SERVER_A = { id: "A", name: "Server A", url: "https://a.example.com", username: "u", password: "p", authMethod: "plaintext" };
const SERVER_B = { id: "B", name: "Server B", url: "https://b.example.com", username: "u", password: "p", authMethod: "plaintext" };

const song = (o: Any = {}) => ({ id: "s", title: "Song", artist: "Artist", album: "Album", duration: 100, track: 1, coverArt: "c", ...o });
const album = (o: Any = {}) => ({ id: "al", name: "Album", artist: "Artist", year: 2005, coverArt: "c", songCount: 10, ...o });
const artist = (o: Any = {}) => ({ id: "ar", name: "Artist", albumCount: 2, coverArt: "c", ...o });

interface SearchData { song?: Any[]; album?: Any[]; artist?: Any[]; }

async function makeEnv(opts: { servers: Any[]; search?: Record<string, SearchData>; failServerIds?: string[] }) {
  const views: Record<string, any> = {};
  const actions: Record<string, (data?: any) => any> = {};
  const streamResolvers: Record<string, (id: string, q?: any) => any> = {};
  const playTracks = vi.fn();

  const api: Any = {
    log: () => {},
    storage: {
      get: vi.fn(async (key: string) => (key === "servers" ? opts.servers : null)),
      set: vi.fn(async () => {}),
    },
    network: {
      fetch: vi.fn(async (url: string) => {
        const server = opts.servers.find((s) => url.startsWith(s.url));
        if (server && opts.failServerIds?.includes(server.id)) throw new Error("network down");
        const body: Any = { "subsonic-response": { status: "ok", version: "1.16.1" } };
        if (url.includes("search3.view") && server) {
          const d = (opts.search && opts.search[server.id]) || {};
          body["subsonic-response"].searchResult3 = { song: d.song || [], album: d.album || [], artist: d.artist || [] };
        }
        return { status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }),
    },
    ui: {
      setViewData: vi.fn((viewId: string, data: any) => { views[viewId] = data; }),
      onAction: vi.fn((id: string, fn: any) => { actions[id] = fn; }),
      showNotification: vi.fn(),
    },
    playback: {
      playTracks,
      onResolveStreamByUri: vi.fn((scheme: string, fn: any) => { streamResolvers[scheme] = fn; }),
      onStreamResolve: vi.fn(),
      onTrackScrobbled: vi.fn(),
    },
    downloads: { onResolveByUri: vi.fn(), onInteractiveSearch: vi.fn(), onInteractiveResolve: vi.fn() },
  };

  const mod = new Function("api", PLUGIN_CODE)(api);
  mod.activate(api);
  // boot reads servers from storage asynchronously — let it settle
  await new Promise((r) => setTimeout(r, 0));

  const view = () => views["subsonic-browse"];
  const child = (type: string) => (view()?.children || []).find((c: Any) => c.type === type);
  const texts = () => (view()?.children || []).filter((c: Any) => c.type === "text").map((c: Any) => c.content);
  const hasEntityTabs = () => (view()?.children || []).some((c: Any) => c.type === "tabs" && (c.tabs || []).some((t: Any) => t.id === "albums"));

  return {
    api, views, actions, streamResolvers, playTracks, view, child, texts,
    fire: (id: string, data?: any) => actions[id]?.(data),
    async search(query: string) {
      actions["do-search"]?.({ query });
      await vi.waitFor(() => expect(hasEntityTabs()).toBe(true));
    },
  };
}

describe("subsonic-browse: cross-server merge", () => {
  const search = {
    A: { song: [song({ id: "sa1" })], album: [album({ id: "ala", songCount: 20 })], artist: [artist({ id: "ara", albumCount: 3 })] },
    B: { song: [song({ id: "sb1" })], album: [album({ id: "alb", songCount: 20 })], artist: [artist({ id: "arb", albumCount: 3 })] },
  };

  it("collapses the same track from two servers into one row tagged '2 servers'", async () => {
    const env = await makeEnv({ servers: [SERVER_A, SERVER_B], search });
    await env.search("song");
    const rows = env.child("track-row-list").items;
    expect(rows).toHaveLength(1);
    expect(rows[0].subtitle).toContain("2 servers");
  });

  it("collapses the same album and shows the agreed track count", async () => {
    const env = await makeEnv({ servers: [SERVER_A, SERVER_B], search });
    await env.search("album");
    env.fire("switch-tab", { tabId: "albums" });
    const cards = env.child("card-grid").items;
    expect(cards).toHaveLength(1);
    expect(cards[0].subtitle).toContain("2 servers");
    expect(cards[0].subtitle).toContain("20 tracks");
  });

  it("collapses the same artist and shows the agreed album count", async () => {
    const env = await makeEnv({ servers: [SERVER_A, SERVER_B], search });
    await env.search("artist");
    env.fire("switch-tab", { tabId: "artists" });
    const cards = env.child("card-grid").items;
    expect(cards).toHaveLength(1);
    expect(cards[0].subtitle).toContain("2 servers");
    expect(cards[0].subtitle).toContain("3 albums");
  });
});

describe("subsonic-browse: per-server count mismatch flags", () => {
  it("flags an album whose track count differs across servers", async () => {
    const env = await makeEnv({
      servers: [SERVER_A, SERVER_B],
      search: {
        A: { album: [album({ id: "ala", songCount: 12 })] },
        B: { album: [album({ id: "alb", songCount: 15 })] },
      },
    });
    await env.search("album");
    env.fire("switch-tab", { tabId: "albums" });
    const sub = env.child("card-grid").items[0].subtitle;
    expect(sub).toContain("⚠");
    expect(sub).toContain("12");
    expect(sub).toContain("15");
    expect(sub).toContain("tracks");
  });

  it("flags an artist whose album count differs across servers", async () => {
    const env = await makeEnv({
      servers: [SERVER_A, SERVER_B],
      search: {
        A: { artist: [artist({ id: "ara", albumCount: 3 })] },
        B: { artist: [artist({ id: "arb", albumCount: 5 })] },
      },
    });
    await env.search("artist");
    env.fire("switch-tab", { tabId: "artists" });
    const sub = env.child("card-grid").items[0].subtitle;
    expect(sub).toContain("⚠");
    expect(sub).toContain("3");
    expect(sub).toContain("5");
    expect(sub).toContain("albums");
  });
});

describe("subsonic-browse: resilience", () => {
  it("returns the reachable server's results and flags the unreachable one", async () => {
    const env = await makeEnv({
      servers: [SERVER_A, SERVER_B],
      failServerIds: ["A"],
      search: { B: { song: [song({ id: "sb1" })] } },
    });
    await env.search("song");
    expect(env.child("track-row-list").items).toHaveLength(1);
    expect(env.texts().some((t: string) => t.includes("unreachable") && t.includes("Server A"))).toBe(true);
  });
});

describe("subsonic-browse: stream failover resolver", () => {
  it("resolves an xsonic:// id to a healthy server's stream URL", async () => {
    const env = await makeEnv({
      servers: [SERVER_A, SERVER_B],
      search: { A: { song: [song({ id: "sa1" })] }, B: { song: [song({ id: "sb1" })] } },
    });
    await env.search("song");
    // primary copy is the first server to return (A); resolver must build A's stream URL
    const url = await env.streamResolvers["xsonic"]("A/sa1");
    expect(url).toContain("https://a.example.com/rest/stream.view");
    expect(url).toContain("id=sa1");
    // and the merged row carries both servers as failover alternates (indexed by either id)
    const viaB = await env.streamResolvers["xsonic"]("B/sb1");
    expect(viaB).toContain("stream.view");
  });
});

describe("subsonic-browse: relevance sort", () => {
  it("orders track results exact-match, then prefix, then substring", async () => {
    const env = await makeEnv({
      servers: [SERVER_A],
      search: {
        A: {
          song: [
            song({ id: "x1", title: "I Need Help", artist: "X" }),
            song({ id: "x2", title: "Help", artist: "X" }),
            song({ id: "x3", title: "Helping Hand", artist: "X" }),
          ],
        },
      },
    });
    await env.search("help");
    const titles = env.child("track-row-list").items.map((i: Any) => i.title);
    expect(titles).toEqual(["Help", "Helping Hand", "I Need Help"]);
  });
});
