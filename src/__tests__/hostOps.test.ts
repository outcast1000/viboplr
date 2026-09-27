// The shared host operations behind both the control API dispatcher and a
// plugin's cross-plugin calls. The point of the module is that the two callers
// cannot drift, so these tests pin the decisions (callable checks, check order,
// limit clamp, arg normalisation) and that the plugin-only `via` wrapper sees
// exactly the call the direct path makes — and is never entered for a request
// that was going to be refused.
import { describe, it, expect, vi } from "vitest";
import {
  clampSearchLimit, invokeAssistantTool, listAssistantTools, listSearchProviders, searchCatalog,
  type AssistantOpsRegistry, type OpVia, type SearchOpsRegistry,
} from "../utils/hostOps";
import type { PluginState } from "../types/plugin";

const state = (id: string, over: Partial<PluginState> = {}) =>
  ({ id, enabled: true, status: "active", ...over }) as Pick<PluginState, "id" | "enabled" | "status">;

function recordingVia() {
  const calls: Array<[string, string]> = [];
  const via: OpVia = (target, what, run) => {
    calls.push([target, what]);
    return run();
  };
  return { via, calls };
}

describe("clampSearchLimit", () => {
  it("defaults, floors and clamps to [1, 100]", () => {
    expect(clampSearchLimit(undefined)).toBe(30);
    expect(clampSearchLimit("10")).toBe(30);
    expect(clampSearchLimit(NaN)).toBe(30);
    expect(clampSearchLimit(Infinity)).toBe(30);
    expect(clampSearchLimit(0)).toBe(1);
    expect(clampSearchLimit(7.9)).toBe(7);
    expect(clampSearchLimit(500)).toBe(100);
  });
});

describe("search ops", () => {
  const reg = (over: Partial<SearchOpsRegistry> = {}): SearchOpsRegistry => ({
    pluginStates: [state("ytdlp"), state("spotify")],
    searchProviders: [
      { pluginId: "ytdlp", providerId: "youtube", name: "YouTube" },
      { pluginId: "spotify", providerId: "catalog", name: "Spotify" },
    ],
    invokePluginSearch: vi.fn(async () => ({ status: "empty" as const })),
    ...over,
  });

  it("lists providers with their full keys", () => {
    expect(listSearchProviders(reg())).toEqual([
      { key: "ytdlp:youtube", pluginId: "ytdlp", providerId: "youtube", name: "YouTube" },
      { key: "spotify:catalog", pluginId: "spotify", providerId: "catalog", name: "Spotify" },
    ]);
  });

  it("resolves a short key, clamps the limit, and returns the answering provider", async () => {
    const r = reg();
    const out = await searchCatalog(r, { providerKey: "youtube", query: "q", limit: 999 });
    expect(r.invokePluginSearch).toHaveBeenCalledWith("ytdlp", "youtube", "q", 100);
    expect(out.provider.pluginId).toBe("ytdlp");
    expect(out.result).toEqual({ status: "empty" });
  });

  it("a provider failure is a result, not a rejection", async () => {
    const r = reg({ invokePluginSearch: async () => ({ status: "error", message: "boom" }) });
    await expect(searchCatalog(r, { providerKey: "ytdlp:youtube", query: "q" }))
      .resolves.toMatchObject({ result: { status: "error", message: "boom" } });
  });

  it("rejects an unknown provider with the roster, without entering via", async () => {
    const { via, calls } = recordingVia();
    await expect(searchCatalog(reg(), { providerKey: "nope", query: "q" }, via))
      .rejects.toThrow(/available: ytdlp:youtube, spotify:catalog/);
    expect(calls).toEqual([]);
  });

  it("rejects a provider whose plugin is not active", async () => {
    const r = reg({ pluginStates: [state("ytdlp", { status: "error" }), state("spotify")] });
    await expect(searchCatalog(r, { providerKey: "ytdlp:youtube", query: "q" }))
      .rejects.toThrow('plugin "ytdlp" is not active (status: error)');
    expect(r.invokePluginSearch).not.toHaveBeenCalled();
  });

  it("routes the invocation through via with the attribution label", async () => {
    const { via, calls } = recordingVia();
    await searchCatalog(reg(), { providerKey: "spotify:catalog", query: "q" }, via);
    expect(calls).toEqual([["spotify", "search:catalog"]]);
  });
});

describe("assistant ops", () => {
  const reg = (over: Partial<AssistantOpsRegistry> = {}): AssistantOpsRegistry => ({
    pluginStates: [state("lastfm"), state("ytdlp")],
    assistantTools: [
      { pluginId: "ytdlp", name: "search", description: "Search" },
      { pluginId: "ytdlp", name: "info", description: "Info" },
      { pluginId: "lastfm", name: "similar", description: "Similar" },
    ],
    assistantInstructions: new Map([["ytdlp", "Use search first."]]),
    pluginNames: new Map([["ytdlp", "yt-dlp"]]),
    invokeAssistantTool: vi.fn(async () => ({ tracks: [] })),
    ...over,
  });

  it("lists the roster, optionally narrowed to one plugin", () => {
    expect(listAssistantTools(reg()).map((p) => p.pluginId)).toEqual(["lastfm", "ytdlp"]);
    const [only] = listAssistantTools(reg(), "ytdlp");
    expect(only).toMatchObject({ pluginId: "ytdlp", name: "yt-dlp", instructions: "Use search first." });
    expect(only.tools.map((t) => t.name)).toEqual(["search", "info"]);
  });

  it("falls back to the plugin id when no display names are known", () => {
    const [p] = listAssistantTools(reg({ pluginNames: undefined }), "lastfm");
    expect(p.name).toBe("lastfm");
  });

  it("invokes a registered tool and resolves with its return value", async () => {
    const r = reg();
    await expect(invokeAssistantTool(r, { pluginId: "ytdlp", tool: "search", args: { query: "x" } }))
      .resolves.toEqual({ tracks: [] });
    expect(r.invokeAssistantTool).toHaveBeenCalledWith("ytdlp", "search", { query: "x" });
  });

  it("normalises non-object args to {}", async () => {
    const r = reg();
    for (const args of [undefined, null, "x", [1, 2]]) {
      await invokeAssistantTool(r, { pluginId: "ytdlp", tool: "search", args });
    }
    for (const call of vi.mocked(r.invokeAssistantTool).mock.calls) expect(call[2]).toEqual({});
  });

  // The drift this module was introduced to end: the control API used to
  // check only `enabled`, so a plugin that failed to activate timed out
  // instead of being refused.
  it("refuses a known tool on a plugin that is enabled but not active", async () => {
    const r = reg({ pluginStates: [state("lastfm"), state("ytdlp", { status: "error" })] });
    await expect(invokeAssistantTool(r, { pluginId: "ytdlp", tool: "search" }))
      .rejects.toThrow('plugin "ytdlp" is not active (status: error)');
    expect(r.invokeAssistantTool).not.toHaveBeenCalled();
  });

  it("'not installed' beats 'no such tool'", async () => {
    await expect(invokeAssistantTool(reg(), { pluginId: "ghost", tool: "search" }))
      .rejects.toThrow('plugin "ghost" is not installed');
  });

  it("a disabled plugin is refused even when its tool is registered", async () => {
    const r = reg({ pluginStates: [state("lastfm"), state("ytdlp", { enabled: false })] });
    await expect(invokeAssistantTool(r, { pluginId: "ytdlp", tool: "search" }))
      .rejects.toThrow('plugin "ytdlp" is disabled');
  });

  it("an unknown tool lists the plugin's tools", async () => {
    await expect(invokeAssistantTool(reg(), { pluginId: "ytdlp", tool: "download" }))
      .rejects.toThrow('plugin "ytdlp" registers no tool "download" (its tools: search, info)');
    await expect(invokeAssistantTool(reg({ assistantTools: [] }), { pluginId: "ytdlp", tool: "x" }))
      .rejects.toThrow("(its tools: none)");
  });

  it("enters via only for a call that will run, with the attribution label", async () => {
    const { via, calls } = recordingVia();
    await expect(invokeAssistantTool(reg(), { pluginId: "ytdlp", tool: "nope" }, via)).rejects.toThrow();
    expect(calls).toEqual([]);
    await invokeAssistantTool(reg(), { pluginId: "lastfm", tool: "similar" }, via);
    expect(calls).toEqual([["lastfm", "tool:similar"]]);
  });

  it("handler rejections propagate", async () => {
    const r = reg({ invokeAssistantTool: async () => { throw new Error("tool \"search\" timed out after 60s"); } });
    await expect(invokeAssistantTool(r, { pluginId: "ytdlp", tool: "search" })).rejects.toThrow("timed out");
  });
});
