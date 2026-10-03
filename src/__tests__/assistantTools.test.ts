// The shared assistant tool catalog (mcp/tools.mjs) and its in-process
// transport (utils/hostAssistantTools.ts, behind api.assistant.host).
//
// The catalog is what an in-app agent picks tools from by category and
// confirms by readOnly, so every tool must declare both — a tool that forgot
// would either be invisible to every feature or run a write unasked.
import { describe, expect, it, vi } from "vitest";
import {
  TOOLS, TOOL_CATEGORIES, PROXY_SEP, buildPluginProxies, isReadOnlyCall, toolsFor,
} from "../../mcp/tools.mjs";
import { inProcessContext, invokeHostTool, listHostTools } from "../utils/hostAssistantTools";
import { checkPermission, describePermission, PermissionError } from "../pluginWorker/permissions";

const ROSTER = {
  plugins: [
    {
      pluginId: "slskd",
      name: "Soulseek",
      instructions: "Search Soulseek.",
      tools: [
        { name: "search", description: "Search", inputSchema: { type: "object", properties: {} }, readOnly: true },
        { name: "download", description: "Download", readOnly: false },
      ],
    },
  ],
};

/** A fake `control_api_call` that records calls and answers per path. */
function fakeInvoke(answer: (method: string, path: string, body: unknown) => { status: number; body: unknown }) {
  const calls: Array<{ method: string; path: string; body: unknown; caller: unknown }> = [];
  const call = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    expect(cmd).toBe("control_api_call");
    const { method, path, body, caller } = args as { method: string; path: string; body: unknown; caller: unknown };
    calls.push({ method, path, body, caller });
    return answer(method, path, body);
  });
  return { call, calls };
}

describe("tool catalog metadata", () => {
  it("every tool declares readOnly and at least one known category", () => {
    for (const t of TOOLS) {
      expect(typeof t.readOnly, t.name).toBe("boolean");
      expect(t.categories.length, t.name).toBeGreaterThan(0);
      for (const c of t.categories) expect(TOOL_CATEGORIES, `${t.name}: ${c}`).toContain(c);
    }
  });

  it("readOnlyWhen only names arguments the tool actually takes", () => {
    for (const t of TOOLS.filter((x) => x.readOnlyWhen)) {
      const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
      for (const key of Object.keys(t.readOnlyWhen!)) expect(props, `${t.name}.${key}`).toHaveProperty(key);
    }
  });

  it("names stay unique and never collide with the plugin-proxy separator", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.includes(PROXY_SEP), n).toBe(false);
  });

  it("isReadOnlyCall honours readOnly and readOnlyWhen", () => {
    const byName = (n: string) => TOOLS.find((t) => t.name === n)!;
    expect(isReadOnlyCall(byName("search_library"), { query: "x" })).toBe(true);
    expect(isReadOnlyCall(byName("play_tracks"), { trackIds: [1] })).toBe(false);
    expect(isReadOnlyCall(byName("collections"), { action: "list" })).toBe(true);
    expect(isReadOnlyCall(byName("collections"), { action: "rescan", collectionId: 1 })).toBe(false);
    expect(isReadOnlyCall(byName("rename_history"), { fromArtist: "a", dryRun: true })).toBe(true);
    expect(isReadOnlyCall(byName("rename_history"), { fromArtist: "a" })).toBe(false);
    expect(isReadOnlyCall(undefined, {})).toBe(false);
  });

  it("the in-app transport leaves out Node-only tools", () => {
    const app = toolsFor("app").map((t) => t.name);
    expect(app).not.toContain("launch_app");
    expect(app).toContain("search_library");
    expect(toolsFor("mcp")).toHaveLength(TOOLS.length);
  });

  it("plugin proxies carry readOnly and the plugins category", () => {
    const proxies = buildPluginProxies(ROSTER);
    expect(proxies.map((p) => [p.name, p.readOnly])).toEqual([
      ["slskd__search", true],
      ["slskd__download", false],
    ]);
    for (const p of proxies) expect(p.categories).toEqual(["plugins"]);
  });
});

describe("in-process transport", () => {
  it("returns the body on 2xx and tags the caller", async () => {
    const { call, calls } = fakeInvoke(() => ({ status: 200, body: { ok: true } }));
    const ctx = inProcessContext("plugin:llm", call);
    await expect(ctx.request("GET", "/v1/health")).resolves.toEqual({ ok: true });
    expect(calls[0]).toEqual({ method: "GET", path: "/v1/health", body: null, caller: "plugin:llm" });
  });

  it("throws the API's own error text on a refusal", async () => {
    const { call } = fakeInvoke(() => ({ status: 403, body: { error: "Turn on Downloads in Settings" } }));
    const ctx = inProcessContext("plugin:llm", call);
    await expect(ctx.request("POST", "/v1/tracks/1/download", {})).rejects.toThrow(
      "HTTP 403: Turn on Downloads in Settings",
    );
  });

  it("runs a catalog tool through its own route", async () => {
    const { call, calls } = fakeInvoke(() => ({ status: 200, body: { tracks: [] } }));
    await invokeHostTool(inProcessContext("plugin:llm", call), "search_library", { query: "Björk", type: "track" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/v1/search?q=Bj%C3%B6rk&type=track");
  });

  it("runs a plugin tool through the gated assistant route and unwraps result", async () => {
    const { call, calls } = fakeInvoke((_m, path) =>
      path === "/v1/assistant/tools" ? { status: 200, body: ROSTER } : { status: 200, body: { result: { hits: 2 } } },
    );
    const out = await invokeHostTool(inProcessContext("plugin:llm", call), "slskd__search", { query: "x" });
    expect(out).toEqual({ hits: 2 });
    expect(calls[1]).toMatchObject({
      method: "POST",
      path: "/v1/assistant/invoke",
      body: { pluginId: "slskd", tool: "search", args: { query: "x" } },
    });
  });

  it("refuses unknown tools, Node-only tools and non-object args", async () => {
    const { call } = fakeInvoke(() => ({ status: 200, body: ROSTER }));
    const ctx = inProcessContext("plugin:llm", call);
    await expect(invokeHostTool(ctx, "nope")).rejects.toThrow(/Unknown tool "nope"/);
    await expect(invokeHostTool(ctx, "launch_app")).rejects.toThrow(/Unknown tool/);
    await expect(invokeHostTool(ctx, "slskd__missing")).rejects.toThrow(/Unknown tool/);
    await expect(invokeHostTool(ctx, "get_status", [] as unknown as Record<string, unknown>)).rejects.toThrow(
      /args must be an object/,
    );
  });

  it("lists app tools first, then plugin tools, as plain data", async () => {
    const { call } = fakeInvoke(() => ({ status: 200, body: ROSTER }));
    const tools = await listHostTools(inProcessContext("plugin:llm", call));
    const names = tools.map((t) => t.name);
    expect(names.slice(-2)).toEqual(["slskd__search", "slskd__download"]);
    expect(names).not.toContain("launch_app");
    for (const t of tools) expect(t).not.toHaveProperty("run");
    expect(tools.find((t) => t.name === "slskd__search")).toMatchObject({ pluginId: "slskd", readOnly: true });
  });
});

describe("assistant:host permission", () => {
  it("gates every api.assistant.host method", () => {
    for (const path of ["assistant.host.listTools", "assistant.host.instructions", "assistant.host.invoke"]) {
      expect(() => checkPermission("llm", [], path, [])).toThrow(PermissionError);
      expect(() => checkPermission("llm", ["assistant:host"], path, [])).not.toThrow();
      // plugins:call is a different grant and must not cover it.
      expect(() => checkPermission("llm", ["plugins:call"], path, [])).toThrow(PermissionError);
    }
  });

  it("is described to the user as sensitive", () => {
    const d = describePermission("assistant:host");
    expect(d.sensitive).toBe(true);
    expect(d.label).toMatch(/AI assistant/);
  });
});
