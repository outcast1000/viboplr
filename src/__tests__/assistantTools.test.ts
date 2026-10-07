// The shared assistant tool catalog (mcp/tools.mjs) and its in-process
// transport (utils/hostAssistantTools.ts, behind api.assistant.host).
//
// The catalog is what an in-app agent picks tools from by category and
// confirms by readOnly, so every tool must declare both — a tool that forgot
// would either be invisible to every feature or run a write unasked.
import { describe, expect, it, vi } from "vitest";
import {
  GUIDES, INSTRUCTIONS, TOOLS, TOOL_CATEGORIES, PROXY_SEP, SHEET_FILE_MAX_BYTES, argProblems, buildPluginProxies, isReadOnlyCall,
  parseSheetFile, runTool, toolsFor,
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

describe("argument checking", () => {
  const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

  it("every catalog schema is checkable: an object with properties and only known required keys", () => {
    for (const t of TOOLS) {
      const s = t.inputSchema as { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };
      expect(s.type, t.name).toBe("object");
      expect(s.additionalProperties, t.name).toBe(false);
      for (const r of s.required ?? []) expect(Object.keys(s.properties ?? {}), t.name).toContain(r);
    }
  });

  it("names the near miss for a wrong argument name", () => {
    expect(argProblems(tool("play_playlist").inputSchema, { id: 5 })).toEqual([
      'unknown argument "id" (did you mean "playlistId"?)',
      '"playlistId" is required',
    ]);
    expect(argProblems(tool("home_shelves").inputSchema, { action: "fetch", shelfId: "x" })).toEqual([
      'unknown argument "shelfId" (did you mean "shelf"?)',
    ]);
  });

  it("checks types and enums, and treats null as not given", () => {
    const s = tool("edit_queue").inputSchema;
    expect(argProblems(s, { action: "jump", index: "3" })).toEqual(['"index" must be a number, got string']);
    expect(argProblems(s, { action: "skip" })[0]).toMatch(/"action" must be one of "add", .*got "skip"/);
    expect(argProblems(s, { action: "jump", index: 2, trackIds: null })).toEqual([]);
  });

  it("refuses before any request, listing what the tool accepts", async () => {
    const { call, calls } = fakeInvoke(() => ({ status: 200, body: {} }));
    const ctx = inProcessContext("plugin:llm", call);
    await expect(invokeHostTool(ctx, "play_playlist", { id: 5 })).rejects.toThrow(
      'play_playlist: unknown argument "id" (did you mean "playlistId"?); "playlistId" is required. ' +
        'Accepted arguments: playlistId (required, number), mode (string, "play"|"end"|"next"), allowDuplicates (boolean).',
    );
    expect(calls).toHaveLength(0);
  });

  it("leaves plugin tools to the plugin", async () => {
    const { call, calls } = fakeInvoke((_m, path) =>
      path === "/v1/assistant/tools" ? { status: 200, body: ROSTER } : { status: 200, body: { result: null } },
    );
    await invokeHostTool(inProcessContext("plugin:llm", call), "slskd__search", { anything: 1 });
    expect(calls[1].body).toMatchObject({ args: { anything: 1 } });
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

describe("instructions and guides", () => {
  // Claude Code truncates server instructions at about 2,000 characters; the
  // safety rules and the guide index must land before the cut, not after it.
  it("keeps the always-sent instructions under the client's cut-off", () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(2000);
    expect(INSTRUCTIONS).toContain("never move, rename or overwrite files");
    for (const topic of Object.keys(GUIDES)) expect(INSTRUCTIONS).toContain(topic);
  });

  it("serves every recipe through the guide tool, and only those", async () => {
    const guide = TOOLS.find((t) => t.name === "guide")!;
    expect(guide.readOnly).toBe(true);
    for (const [topic, text] of Object.entries(GUIDES)) {
      await expect(runTool(guide, { topic }, { request: vi.fn() })).resolves.toEqual({ topic, guide: text });
    }
    await expect(runTool(guide, { topic: "nope" }, { request: vi.fn() })).rejects.toThrow(/must be one of/);
  });

  it("points the recipes at each other through the guide tool, not at missing prose", () => {
    for (const text of Object.values(GUIDES)) expect(text).not.toMatch(/see the \w[\w-]* recipe/);
  });
});

describe("cue_sheet sheetFile", () => {
  const cueTool = TOOLS.find((t) => t.name === "cue_sheet")!;
  const CUES = [{ at: 1, kind: "text", text: "Hello" }];

  /** A transport with a fake file system: path → text. */
  function fileCtx(files: Record<string, string>) {
    const request = vi.fn(async (_m: string, _p: string, _b?: unknown) => ({ ok: true }));
    const readTextFile = vi.fn(async (path: string, maxBytes: number) => {
      expect(maxBytes).toBe(SHEET_FILE_MAX_BYTES);
      if (!(path in files)) throw new Error(`${path} does not exist`);
      return files[path];
    });
    return { ctx: { request, readTextFile }, request, readTextFile };
  }

  it("sends a sheet read from a file through the same PUT as inline cues", async () => {
    const { ctx, request } = fileCtx({ "/tmp/s.json": JSON.stringify({ mode: "clip", cues: CUES }) });
    await runTool(cueTool, { action: "set", title: "Jóga", artistName: "Björk", sheetFile: "/tmp/s.json", author: "AI" }, ctx);
    expect(request).toHaveBeenCalledWith("PUT", "/v1/cues", {
      title: "Jóga", artistName: "Björk", sheet: { mode: "clip", cues: CUES }, author: "AI",
    });
  });

  it("passes a file's track block and author through to the app, and still takes source", async () => {
    const track = { title: "Jóga", artistName: "Björk" };
    const { ctx, request } = fileCtx({ "/t.json": JSON.stringify({ track, author: "Claude", cues: CUES }) });
    await runTool(cueTool, { action: "set", sheetFile: "/t.json" }, ctx);
    expect(request.mock.calls[0][2]).toMatchObject({ sheet: { track, author: "Claude", cues: CUES } });
    // The pre-1.0.93 argument name still lands as author.
    await runTool(cueTool, { action: "set", cues: CUES, source: "Old client" }, ctx);
    expect(request.mock.calls[1][2]).toMatchObject({ author: "Old client" });
  });

  it("accepts a bare cues array, and a mode argument overrides the file's", async () => {
    const { ctx, request } = fileCtx({ "/a.json": JSON.stringify(CUES), "/b.json": JSON.stringify({ mode: "clip", cues: CUES }) });
    await runTool(cueTool, { action: "set", sheetFile: "/a.json" }, ctx);
    expect(request.mock.calls[0][2]).toMatchObject({ sheet: { mode: undefined, cues: CUES } });
    await runTool(cueTool, { action: "set", sheetFile: "/b.json", mode: "cards" }, ctx);
    expect(request.mock.calls[1][2]).toMatchObject({ sheet: { mode: "cards", cues: CUES } });
  });

  it("refuses cues plus sheetFile, and neither, before any request", async () => {
    const { ctx, request, readTextFile } = fileCtx({});
    await expect(runTool(cueTool, { action: "set", cues: CUES, sheetFile: "/x.json" }, ctx)).rejects.toThrow(
      "pass either cues or sheetFile, not both",
    );
    await expect(runTool(cueTool, { action: "set" }, ctx)).rejects.toThrow(/"cues" is required .*sheetFile/);
    expect(request).not.toHaveBeenCalled();
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("is refused in the in-app transport, which has no file system", async () => {
    const { call, calls } = fakeInvoke(() => ({ status: 200, body: {} }));
    await expect(
      invokeHostTool(inProcessContext("plugin:llm", call), "cue_sheet", { action: "set", sheetFile: "/x.json" }),
    ).rejects.toThrow(/only available through the MCP server/);
    expect(calls).toHaveLength(0);
  });

  it("parses the two sheet shapes and never quotes a bad file back", () => {
    expect(parseSheetFile(JSON.stringify(CUES), "/a")).toEqual({ cues: CUES });
    expect(parseSheetFile(JSON.stringify({ mode: "clip", cues: CUES, extra: 1 }), "/a")).toEqual({ mode: "clip", cues: CUES });
    const secret = "SECRET-CONTENTS not json";
    expect(() => parseSheetFile(secret, "/etc/x")).toThrow(/^sheetFile \/etc\/x is not valid JSON/);
    expect(() => parseSheetFile(secret, "/etc/x")).not.toThrow(/SECRET/);
    expect(() => parseSheetFile(JSON.stringify({ secret: "SECRET" }), "/etc/y")).toThrow(
      "sheetFile /etc/y must hold { cues: [...] } (optionally with mode, track, author) or a bare cues array",
    );
  });
});
