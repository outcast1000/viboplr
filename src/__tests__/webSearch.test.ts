// Web search as a shared service: the pure helpers (utils/webSearch.ts) and
// the one operation both callers run (hostOps.webSearch). What is pinned here
// is what a caller relies on — the user's order and switches are obeyed, an
// engine that fails hands over instead of failing the search, a working
// engine's "nothing found" ends it, and nothing a provider sends reaches a
// caller unchecked.
import { describe, it, expect, vi } from "vitest";
import { listWebSearchProviders, webSearch, type OpVia, type WebSearchOpsRegistry } from "../utils/hostOps";
import {
  clampWebSearchLimit, mergeWebSearchOrder, normalizeWebSearchResult, orderWebSearchProviders,
  walkWebSearchProviders, type OrderedWebSearchProvider,
} from "../utils/webSearch";
import type { PluginState, PluginWebSearchResult } from "../types/plugin";

const state = (id: string, over: Partial<PluginState> = {}) =>
  ({ id, enabled: true, status: "active", ...over }) as Pick<PluginState, "id" | "enabled" | "status">;

const provider = (pluginId: string, providerId: string, name: string, enabled = true): OrderedWebSearchProvider => ({
  pluginId, providerId, name, key: `${pluginId}:${providerId}`, enabled,
});

const hit = (n: number) => ({ title: `Page ${n}`, url: `https://example.com/${n}`, snippet: `about ${n}` });

describe("clampWebSearchLimit", () => {
  it("defaults to 10, floors and clamps to [1, 25]", () => {
    expect(clampWebSearchLimit(undefined)).toBe(10);
    expect(clampWebSearchLimit("5")).toBe(10);
    expect(clampWebSearchLimit(0)).toBe(1);
    expect(clampWebSearchLimit(3.7)).toBe(3);
    expect(clampWebSearchLimit(100)).toBe(25);
  });
});

describe("orderWebSearchProviders", () => {
  const ddg = { pluginId: "duckduckgo", providerId: "web", name: "DuckDuckGo" };
  const brave = { pluginId: "brave", providerId: "web", name: "Brave" };

  it("puts stored entries first in stored order, with their switches", () => {
    const out = orderWebSearchProviders([ddg, brave], [
      { id: "brave:web", enabled: false },
      { id: "duckduckgo:web", enabled: true },
    ]);
    expect(out.map((p) => [p.key, p.enabled])).toEqual([["brave:web", false], ["duckduckgo:web", true]]);
  });

  it("appends a newly installed provider, switched on", () => {
    const out = orderWebSearchProviders([ddg, brave], [{ id: "brave:web", enabled: true }]);
    expect(out.map((p) => [p.key, p.enabled])).toEqual([["brave:web", true], ["duckduckgo:web", true]]);
  });

  it("skips stored entries for providers that aren't registered, and survives garbage", () => {
    expect(orderWebSearchProviders([ddg], [{ id: "gone:web", enabled: true }]).map((p) => p.key)).toEqual(["duckduckgo:web"]);
    expect(orderWebSearchProviders([ddg], null).map((p) => p.key)).toEqual(["duckduckgo:web"]);
    expect(orderWebSearchProviders([ddg], "nonsense" as never).map((p) => p.key)).toEqual(["duckduckgo:web"]);
  });
});

describe("mergeWebSearchOrder", () => {
  it("writes the shown rows first and keeps where an absent provider sat", () => {
    const next = mergeWebSearchOrder(
      [{ key: "duckduckgo:web", enabled: true }, { key: "brave:web", enabled: false }],
      [{ id: "brave:web", enabled: true }, { id: "offline:web", enabled: false }, { id: "duckduckgo:web", enabled: true }],
    );
    expect(next).toEqual([
      { id: "duckduckgo:web", enabled: true },
      { id: "brave:web", enabled: false },
      { id: "offline:web", enabled: false },
    ]);
  });
});

describe("normalizeWebSearchResult", () => {
  it("keeps http(s) links with a title, fills site, collapses whitespace", () => {
    const out = normalizeWebSearchResult({
      status: "ok",
      results: [{ title: "  Portishead\n– Wikipedia ", url: "https://www.en.wikipedia.org/wiki/Portishead", snippet: "Bristol\n\nband" }],
    }, 10);
    expect(out).toEqual({
      status: "ok",
      results: [{
        title: "Portishead – Wikipedia",
        url: "https://www.en.wikipedia.org/wiki/Portishead",
        snippet: "Bristol band",
        site: "en.wikipedia.org",
      }],
    });
  });

  it("drops non-web links, untitled rows and repeated URLs, then trims to the limit", () => {
    const out = normalizeWebSearchResult({
      status: "ok",
      results: [
        { title: "evil", url: "javascript:alert(1)" },
        { title: "local", url: "file:///etc/passwd" },
        { title: "", url: "https://example.com/blank" },
        hit(1), hit(1), hit(2), hit(3),
        null, "string",
      ],
    }, 2);
    expect(out.status).toBe("ok");
    expect(out.status === "ok" && out.results.map((r) => r.url)).toEqual(["https://example.com/1", "https://example.com/2"]);
  });

  it("caps a snippet that is really page text", () => {
    const out = normalizeWebSearchResult({ status: "ok", results: [{ ...hit(1), snippet: "x".repeat(5000) }] }, 10);
    expect(out.status === "ok" && out.results[0].snippet!.length).toBeLessThanOrEqual(400);
  });

  it("ok with nothing usable is a miss; malformed answers are misses; errors keep their message", () => {
    expect(normalizeWebSearchResult({ status: "ok", results: [{ title: "x", url: "ftp://x" }] }, 10)).toEqual({ status: "empty" });
    expect(normalizeWebSearchResult({ status: "ok" }, 10)).toEqual({ status: "empty" });
    expect(normalizeWebSearchResult(undefined, 10)).toEqual({ status: "empty" });
    expect(normalizeWebSearchResult({ status: "error", message: "blocked" }, 10)).toEqual({ status: "error", message: "blocked" });
    expect(normalizeWebSearchResult({ status: "error" }, 10)).toEqual({ status: "error", message: undefined });
  });
});

describe("walkWebSearchProviders budget", () => {
  it("shares one budget across the walk and lists the providers it never reached", async () => {
    vi.useFakeTimers();
    try {
      const hang = () => new Promise<PluginWebSearchResult>(() => {});
      const ask = vi.fn(hang);
      const walk = walkWebSearchProviders(
        [provider("a", "web", "A"), provider("b", "web", "B"), provider("c", "web", "C")],
        ask,
        { budgetMs: 1000 },
      );
      await vi.advanceTimersByTimeAsync(1000);
      await expect(walk).resolves.toEqual({
        status: "error",
        message: "A: timed out; B: not asked (the search ran out of time); C: not asked (the search ran out of time)",
      });
      expect(ask).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("webSearch op", () => {
  const reg = (
    answers: Record<string, PluginWebSearchResult>,
    over: Partial<WebSearchOpsRegistry> = {},
  ): WebSearchOpsRegistry & { invokeWebSearch: ReturnType<typeof vi.fn> } => ({
    pluginStates: [state("duckduckgo"), state("brave")],
    webSearchProviders: [provider("duckduckgo", "web", "DuckDuckGo"), provider("brave", "web", "Brave")],
    invokeWebSearch: vi.fn(async (pluginId: string, providerId: string) => answers[`${pluginId}:${providerId}`] ?? { status: "empty" }),
    ...over,
  }) as WebSearchOpsRegistry & { invokeWebSearch: ReturnType<typeof vi.fn> };

  it("uses the first provider in the user's order and names it", async () => {
    const r = reg({ "duckduckgo:web": { status: "ok", results: [hit(1)] } });
    const out = await webSearch(r, { query: "portishead" });
    expect(out).toMatchObject({ status: "ok", provider: "duckduckgo:web", providerName: "DuckDuckGo" });
    expect(r.invokeWebSearch).toHaveBeenCalledTimes(1);
    expect(r.invokeWebSearch).toHaveBeenCalledWith("duckduckgo", "web", "portishead", 10);
  });

  it("an engine that errors hands over to the next", async () => {
    const r = reg({
      "duckduckgo:web": { status: "error", message: "blocked" },
      "brave:web": { status: "ok", results: [hit(2)] },
    });
    const out = await webSearch(r, { query: "q" });
    expect(out).toMatchObject({ status: "ok", provider: "brave:web" });
  });

  it("a working engine's 'nothing found' ends the walk", async () => {
    const r = reg({ "duckduckgo:web": { status: "empty" }, "brave:web": { status: "ok", results: [hit(1)] } });
    const out = await webSearch(r, { query: "q" });
    expect(out).toMatchObject({ status: "empty", provider: "duckduckgo:web" });
    expect(r.invokeWebSearch).toHaveBeenCalledTimes(1);
  });

  it("when every engine fails, the error names each one's reason", async () => {
    const r = reg({
      "duckduckgo:web": { status: "error", message: "blocked" },
      "brave:web": { status: "error", message: "timed out" },
    });
    const out = await webSearch(r, { query: "q" });
    expect(out.status).toBe("error");
    expect(out.status === "error" && out.message).toBe("DuckDuckGo: blocked; Brave: timed out");
  });

  it("never asks a switched-off provider or one whose plugin isn't running", async () => {
    const r = reg(
      { "brave:web": { status: "ok", results: [hit(1)] } },
      {
        pluginStates: [state("duckduckgo", { status: "error" }), state("brave")],
        webSearchProviders: [
          provider("off", "web", "Off", false),
          provider("duckduckgo", "web", "DuckDuckGo"),
          provider("brave", "web", "Brave"),
        ],
      },
    );
    const out = await webSearch(r, { query: "q" });
    expect(out).toMatchObject({ provider: "brave:web" });
    expect(r.invokeWebSearch.mock.calls.map((c) => c[0])).toEqual(["brave"]);
  });

  it("a named provider runs alone; a switched-off one is refused, not run", async () => {
    const r = reg(
      { "brave:web": { status: "ok", results: [hit(1)] } },
      { webSearchProviders: [provider("duckduckgo", "web", "DuckDuckGo", false), provider("brave", "web", "Brave")] },
    );
    await expect(webSearch(r, { query: "q", provider: "brave" })).resolves.toMatchObject({ provider: "brave:web" });
    await expect(webSearch(r, { query: "q", provider: "duckduckgo:web" })).rejects.toThrow(/switched off/);
    await expect(webSearch(r, { query: "q", provider: "nope" })).rejects.toThrow(/no web search provider matches/);
    expect(r.invokeWebSearch).toHaveBeenCalledTimes(1);
  });

  it("a named provider is resolved among switched-on ones only", async () => {
    // Two engines from one plugin, one off: the bare plugin id is not
    // ambiguous, and no error lists the engine the user turned off.
    const r = reg(
      { "multi:on": { status: "ok", results: [hit(1)] } },
      {
        pluginStates: [state("multi")],
        webSearchProviders: [provider("multi", "off", "Hidden", false), provider("multi", "on", "Shown")],
      },
    );
    await expect(webSearch(r, { query: "q", provider: "multi" })).resolves.toMatchObject({ provider: "multi:on" });
    await expect(webSearch(r, { query: "q", provider: "nope" })).rejects.toThrow(/available: multi:on\)/);
  });

  it("a named provider's failure is a result, not a rejection", async () => {
    const r = reg({ "duckduckgo:web": { status: "error", message: "blocked" } });
    await expect(webSearch(r, { query: "q", provider: "duckduckgo:web" }))
      .resolves.toEqual({ status: "error", message: "blocked", provider: "duckduckgo:web", providerName: "DuckDuckGo" });
  });

  it("rejects a bad request: no query, nothing installed, everything off", async () => {
    await expect(webSearch(reg({}), { query: "   " })).rejects.toThrow(/query is required/);
    await expect(webSearch(reg({}, { webSearchProviders: [] }), { query: "q" })).rejects.toThrow(/no web search provider is installed/);
    await expect(
      webSearch(reg({}, { webSearchProviders: [provider("duckduckgo", "web", "DuckDuckGo", false)] }), { query: "q" }),
    ).rejects.toThrow(/switched off or not running/);
  });

  it("goes through `via` per provider, and a refused hop (a call cycle) only rules that provider out", async () => {
    const r = reg({ "brave:web": { status: "ok", results: [hit(1)] } });
    const calls: string[] = [];
    const via: OpVia = (target, what, run) => {
      calls.push(`${target}:${what}`);
      if (target === "duckduckgo") return Promise.reject(new Error("cross-plugin call cycle: duckduckgo → duckduckgo"));
      return run();
    };
    const out = await webSearch(r, { query: "q", limit: 3 }, via);
    expect(calls).toEqual(["duckduckgo:websearch:web", "brave:websearch:web"]);
    expect(out).toMatchObject({ status: "ok", provider: "brave:web" });
    expect(r.invokeWebSearch).toHaveBeenCalledWith("brave", "web", "q", 3);
  });

  it("listWebSearchProviders lists only the switched-on ones, in order", () => {
    const listed = listWebSearchProviders({
      webSearchProviders: [provider("brave", "web", "Brave"), provider("duckduckgo", "web", "DuckDuckGo", false)],
    });
    expect(listed).toEqual([{ key: "brave:web", pluginId: "brave", providerId: "web", name: "Brave" }]);
  });
});
