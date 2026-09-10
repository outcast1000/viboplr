// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs script, no type declarations
import { TOOLS, parseCliArgs, versionCmp, launchCommands } from "../../mcp/viboplr-mcp.mjs";

// The MCP server is the one satellite that talks to the control API on the
// user's behalf from clients we don't control, so the protocol handshake, the
// tier split, and — above all — that the bearer token never leaves the server
// process are pinned here against a spawned real instance.

const SERVER = join(__dirname, "..", "..", "mcp", "viboplr-mcp.mjs");
const TEST_TOKEN = "tok_secret_test_1234567890";

const FULL_ONLY = [
  "plugin_actions",
  "plugin_deep_link",
  "plugin_tools",
  "manage_extensions",
  "window_control",
  "logs",
  "get_entity_image",
];

// ---------------------------------------------------------------------------
// Fixtures: a fake control API + a spawned MCP server speaking stdio JSON-RPC

interface SeenRequest {
  method: string;
  url: string;
  auth: string | undefined;
  body?: string;
}

function startFakeApi(): Promise<{ port: number; seen: SeenRequest[]; close: () => void; failQueueOnce: () => void }> {
  const seen: SeenRequest[] = [];
  let queue503 = false;
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
    const reply = (code: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(text);
    };
    if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) return reply(401, { error: "unauthorized" });
    if (req.url === "/v1/health") return reply(200, { ok: true, version: "1.0.57", profile: "default" });
    if (req.url === "/v1/status")
      return reply(200, { playing: true, positionSecs: 12, queueIndex: 0, queueLength: 3, currentTrack: { title: "Jóga" } });
    if (req.url === "/v1/queue") {
      if (queue503) {
        queue503 = false;
        return reply(503, { error: "starting" });
      }
      return reply(200, { index: 0, mode: "normal", tracks: [] });
    }
    if (req.url?.startsWith("/v1/search")) return reply(200, { tracks: [{ id: 7, title: "Jóga" }], total: 1 });
    if (req.url === "/v1/collections" && req.method === "GET")
      return reply(200, [{ id: 3, kind: "local", name: "Music", track_count: 42 }]);
    if (req.url === "/v1/collections/3/rescan" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen[seen.length - 1].body = body;
        reply(200, { started: true, name: "Music", full: JSON.parse(body).full === true });
      });
      return;
    }
    if (req.url === "/v1/query/schema" && req.method === "GET")
      return reply(200, { tables: [{ name: "tracks", sql: "CREATE TABLE tracks (...)" }], notes: ["history is name-keyed"] });
    if (req.url === "/v1/query" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen[seen.length - 1].body = body;
        const q = JSON.parse(body);
        if (/collections|plugin_storage/i.test(q.sql)) return reply(400, { error: "off-limits" });
        reply(200, { columns: ["title"], rows: [["Jóga"]], rowCount: 1, truncated: false });
      });
      return;
    }
    if (req.url === "/v1/assistant/tools" && req.method === "GET")
      return reply(200, {
        plugins: [{
          pluginId: "mock-download",
          name: "Mock Download",
          instructions: "Mock provider for testing.",
          tools: [{ name: "search_catalog", description: "Search the fake catalog", inputSchema: null }],
        }],
      });
    if (req.url === "/v1/assistant/invoke" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen[seen.length - 1].body = body;
        reply(200, { result: { matches: [{ id: "mock-7" }] } });
      });
      return;
    }
    if (req.url === "/v1/extensions/gallery" && req.method === "GET")
      return reply(200, {
        plugins: [{ id: "ytdlp", name: "yt-dlp", installed: true }, { id: "qbittorrent", installed: false }],
        skins: [],
        note: "read-only",
      });
    if (req.url === "/v1/extensions/ytdlp" && req.method === "GET")
      return reply(200, {
        id: "ytdlp",
        contributes: { downloadProviders: [{ id: "ytdlp-download", name: "yt-dlp" }] },
        live: { searchProviders: [{ key: "ytdlp:youtube", name: "YouTube" }] },
      });
    return reply(404, { error: `no fake route for ${req.url}` });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        seen,
        close: () => server.close(),
        failQueueOnce: () => {
          queue503 = true;
        },
      });
    });
  });
}

function writeDiscovery(port: number, profile = "default"): string {
  const dir = mkdtempSync(join(tmpdir(), "viboplr-mcp-test-"));
  mkdirSync(join(dir, profile));
  writeFileSync(
    join(dir, profile, "control-api.json"),
    JSON.stringify({ port, token: TEST_TOKEN, profile, pid: 1, startedAt: "now" }),
  );
  return dir;
}

interface Rpc {
  proc: ChildProcessWithoutNullStreams;
  request: (method: string, params?: unknown) => Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  rawStdout: () => string;
  kill: () => void;
}

function startFakeGithub(tag: string): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/repos/outcast1000/viboplr/releases/latest") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          tag_name: tag,
          html_url: `https://github.com/outcast1000/viboplr/releases/tag/${tag}`,
          published_at: "2026-09-01T00:00:00Z",
          prerelease: false,
        }),
      );
    } else {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as { port: number }).port, close: () => server.close() });
    });
  });
}

function startServer(discoveryDir: string, extraArgs: string[] = [], extraEnv: Record<string, string> = {}): Rpc {
  const proc = spawn(process.execPath, [SERVER, ...extraArgs], {
    env: { ...process.env, VIBOPLR_MCP_DISCOVERY_DIR: discoveryDir, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let raw = "";
  let buf = "";
  let nextId = 1;
  const pending = new Map<number, (msg: never) => void>();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    raw += chunk;
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg as never);
      }
    }
  });
  return {
    proc,
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }, 15_000);
        pending.set(id, ((msg: { result?: unknown; error?: { code: number; message: string } }) => {
          clearTimeout(timer);
          resolve(msg);
        }) as never);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }),
    rawStdout: () => raw,
    kill: () => proc.kill(),
  };
}

function toolText(result: unknown): string {
  const r = result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  return r.content[0]?.text ?? "";
}

// ---------------------------------------------------------------------------

describe("tool table (static)", () => {
  it("splits into default and full tiers as designed", () => {
    const names = TOOLS.map((t: { name: string }) => t.name);
    expect(new Set(names).size).toBe(names.length);
    const fullNames = TOOLS.filter((t: { tier?: string }) => t.tier === "full").map((t: { name: string }) => t.name);
    expect(fullNames.sort()).toEqual([...FULL_ONLY].sort());
    for (const t of TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("compares versions numerically, tolerating v-prefixes and beta suffixes", () => {
    expect(versionCmp("1.0.57", "1.0.57")).toBe(0);
    expect(versionCmp("v1.0.57", "1.0.57")).toBe(0);
    expect(versionCmp("1.0.58", "1.0.57")).toBeGreaterThan(0);
    expect(versionCmp("1.0.9", "1.0.57")).toBeLessThan(0);
    expect(versionCmp("1.1.0", "1.0.99")).toBeGreaterThan(0);
    expect(versionCmp("1.0.58-beta.1", "1.0.57")).toBeGreaterThan(0);
  });

  it("builds platform-appropriate launch candidates", () => {
    const mac = launchCommands("darwin", {});
    expect(mac[0]).toEqual({ cmd: "open", args: ["-b", "com.alex.viboplr"] });
    expect(mac[1].args).toEqual(["-a", "Viboplr"]);

    const win = launchCommands("win32", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local", ProgramFiles: "C:\\Program Files" });
    expect(win.map((c: { exe: string }) => c.exe)).toEqual([
      "C:\\Users\\x\\AppData\\Local\\Viboplr\\viboplr.exe",
      "C:\\Users\\x\\AppData\\Local\\Programs\\Viboplr\\viboplr.exe",
      "C:\\Program Files\\Viboplr\\viboplr.exe",
    ]);

    expect(launchCommands("linux", {})).toEqual([{ cmd: "viboplr", args: [] }]);
  });

  it("parses tier and profile from argv, rejecting garbage", () => {
    expect(parseCliArgs([], {})).toEqual({ tier: "default", profile: undefined });
    expect(parseCliArgs(["--tier=full"], {})).toEqual({ tier: "full", profile: undefined });
    expect(parseCliArgs(["--tier", "full", "--profile", "perf"], {})).toEqual({ tier: "full", profile: "perf" });
    expect(parseCliArgs([], { VIBOPLR_MCP_TIER: "full" })).toEqual({ tier: "full", profile: undefined });
    // CLI flag wins over env
    expect(parseCliArgs(["--tier=default"], { VIBOPLR_MCP_TIER: "full" }).tier).toBe("default");
    expect(() => parseCliArgs(["--tier=admin"], {})).toThrow(/--tier/);
    expect(() => parseCliArgs(["--bogus"], {})).toThrow(/unknown argument/);
  });
});

describe("MCP server over stdio", () => {
  let api: Awaited<ReturnType<typeof startFakeApi>>;
  let github: Awaited<ReturnType<typeof startFakeGithub>>;
  let rpc: Rpc;

  beforeAll(async () => {
    api = await startFakeApi();
    github = await startFakeGithub("v9.9.9");
    rpc = startServer(writeDiscovery(api.port), [], {
      VIBOPLR_MCP_GITHUB_API: `http://127.0.0.1:${github.port}`,
    });
  });

  afterAll(() => {
    rpc.kill();
    api.close();
    github.close();
  });

  it("negotiates the handshake and declares tools", async () => {
    const init = await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const result = init.result as { protocolVersion: string; capabilities: object; serverInfo: { name: string } };
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.serverInfo.name).toBe("viboplr");
    expect(result.capabilities).toHaveProperty("tools");
  });

  it("lists only default-tier tools without --tier=full", async () => {
    const res = await rpc.request("tools/list");
    const names = (res.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain("search_library");
    expect(names).toContain("playback_control");
    expect(names).toContain("home_shelves");
    expect(names).toContain("app_version");
    expect(names).toContain("collections");
    for (const full of FULL_ONLY) expect(names).not.toContain(full);
  });

  it("answers launch_app with alreadyRunning when the app is reachable", async () => {
    const res = await rpc.request("tools/call", { name: "launch_app", arguments: {} });
    const info = JSON.parse(toolText(res.result));
    expect(info.alreadyRunning).toBe(true);
    expect(info.version).toBe("1.0.57");
  });

  it("proxies a tool call with the bearer token from the discovery file", async () => {
    const res = await rpc.request("tools/call", { name: "get_status", arguments: {} });
    const status = JSON.parse(toolText(res.result));
    expect(status.currentTrack.title).toBe("Jóga");
    const statusReq = api.seen.find((r) => r.url === "/v1/status");
    expect(statusReq?.auth).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("posts query_library SQL with params and surfaces the refusal for blocked tables", async () => {
    const res = await rpc.request("tools/call", {
      name: "query_library",
      arguments: { sql: "SELECT title FROM tracks WHERE id = ?", params: [7], limit: 5 },
    });
    expect(JSON.parse(toolText(res.result)).rows).toEqual([["Jóga"]]);
    const posted = api.seen.find((r) => r.method === "POST" && r.url === "/v1/query");
    expect(JSON.parse(posted!.body!)).toEqual({ sql: "SELECT title FROM tracks WHERE id = ?", params: [7], limit: 5 });

    const blocked = await rpc.request("tools/call", {
      name: "query_library",
      arguments: { sql: "SELECT * FROM collections" },
    });
    expect((blocked.result as { isError?: boolean }).isError).toBe(true);
    expect(toolText(blocked.result)).toContain("off-limits");

    // schema=true fetches the DDL + semantic notes; no sql needed.
    const schema = await rpc.request("tools/call", {
      name: "query_library",
      arguments: { schema: true },
    });
    expect(JSON.parse(toolText(schema.result)).notes).toEqual(["history is name-keyed"]);

    // Neither sql nor schema is a caller error, not a request.
    const neither = await rpc.request("tools/call", { name: "query_library", arguments: {} });
    expect((neither.result as { isError?: boolean }).isError).toBe(true);
  });

  it("maps tool arguments onto query strings", async () => {
    await rpc.request("tools/call", { name: "search_library", arguments: { query: "jóga", type: "track", limit: 5 } });
    const req = api.seen.find((r) => r.url.startsWith("/v1/search"));
    expect(req?.url).toContain("type=track");
    expect(req?.url).toContain("limit=5");
  });

  it("lists collections and posts a rescan with the full flag", async () => {
    const list = await rpc.request("tools/call", { name: "collections", arguments: { action: "list" } });
    expect(JSON.parse(toolText(list.result))[0].name).toBe("Music");

    const rescan = await rpc.request("tools/call", {
      name: "collections",
      arguments: { action: "rescan", collectionId: 3, full: true },
    });
    expect(JSON.parse(toolText(rescan.result)).started).toBe(true);
    const posted = api.seen.find((r) => r.url === "/v1/collections/3/rescan");
    expect(posted?.method).toBe("POST");
    expect(JSON.parse(posted?.body ?? "{}").full).toBe(true);
  });

  it("reports the installed version and its own tier without touching GitHub by default", async () => {
    const res = await rpc.request("tools/call", { name: "app_version", arguments: {} });
    const info = JSON.parse(toolText(res.result));
    expect(info).toEqual({
      installed: "1.0.57",
      profile: "default",
      mcp: { version: expect.any(String), tier: "default" },
    });
  });

  it("declares its tier in the initialize instructions", async () => {
    const init = await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const instructions = (init.result as { instructions: string }).instructions;
    expect(instructions).toContain("default tool tier");
    expect(instructions).toContain("--tier=full");
  });

  it("compares the installed version against the latest GitHub release on request", async () => {
    const res = await rpc.request("tools/call", { name: "app_version", arguments: { checkLatest: true } });
    const info = JSON.parse(toolText(res.result));
    expect(info.installed).toBe("1.0.57");
    expect(info.latest.version).toBe("9.9.9");
    expect(info.latest.url).toContain("/releases/tag/v9.9.9");
    expect(info.upToDate).toBe(false);
    expect(info.latestError).toBeUndefined();
  });

  it("still answers app_version when GitHub is unreachable", async () => {
    const offline = startServer(writeDiscovery(api.port), [], { VIBOPLR_MCP_GITHUB_API: "http://127.0.0.1:1" });
    try {
      const res = await offline.request("tools/call", { name: "app_version", arguments: { checkLatest: true } });
      const info = JSON.parse(toolText(res.result));
      expect(info.installed).toBe("1.0.57");
      expect(info.latest).toBeUndefined();
      expect(info.latestError).toContain("latest release");
    } finally {
      offline.kill();
    }
  });

  it("retries a 503 (app starting) instead of failing", async () => {
    api.failQueueOnce();
    const res = await rpc.request("tools/call", { name: "get_queue", arguments: {} });
    expect((res.result as { isError?: boolean }).isError).toBeUndefined();
    expect(JSON.parse(toolText(res.result)).mode).toBe("normal");
  }, 20_000);

  it("refuses full-tier tools at the default tier", async () => {
    const res = await rpc.request("tools/call", { name: "manage_extensions", arguments: { action: "list" } });
    expect(res.error?.code).toBe(-32602);
  });

  it("surfaces tool-level failures as isError results, not protocol errors", async () => {
    const res = await rpc.request("tools/call", { name: "browse", arguments: { kind: "artist_tracks" } });
    const r = res.result as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(toolText(res.result)).toContain('"id" is required');
  });

  it("answers unknown methods with -32601 and ignores notifications", async () => {
    rpc.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const res = await rpc.request("resources/list");
    expect(res.error?.code).toBe(-32601);
  });

  it("never lets the token reach stdout", () => {
    // Everything the model or client ever sees went through stdout — after all
    // of the calls above, the token must not appear anywhere in it.
    expect(rpc.rawStdout()).not.toContain(TEST_TOKEN);
  });
});

describe("MCP server at --tier=full", () => {
  let api: Awaited<ReturnType<typeof startFakeApi>>;
  let rpc: Rpc;

  beforeAll(async () => {
    api = await startFakeApi();
    rpc = startServer(writeDiscovery(api.port), ["--tier=full"]);
  });

  afterAll(() => {
    rpc.kill();
    api.close();
  });

  it("lists every tool including the full tier", async () => {
    const res = await rpc.request("tools/list");
    const names = (res.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    for (const full of FULL_ONLY) expect(names).toContain(full);
    expect(names.length).toBe(TOOLS.length);
  });

  it("reports tier full in app_version and the instructions", async () => {
    const init = await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect((init.result as { instructions: string }).instructions).toContain("full tool tier");

    const res = await rpc.request("tools/call", { name: "app_version", arguments: {} });
    expect(JSON.parse(toolText(res.result)).mcp.tier).toBe("full");
  });

  it("lists and invokes plugin assistant tools", async () => {
    const list = await rpc.request("tools/call", {
      name: "plugin_tools",
      arguments: { action: "list" },
    });
    const roster = JSON.parse(toolText(list.result));
    expect(roster.plugins[0].tools[0].name).toBe("search_catalog");

    const invoked = await rpc.request("tools/call", {
      name: "plugin_tools",
      arguments: { action: "invoke", pluginId: "mock-download", tool: "search_catalog", args: { query: "nirvana" } },
    });
    expect(JSON.parse(toolText(invoked.result)).result.matches[0].id).toBe("mock-7");
    const posted = api.seen.find((r) => r.method === "POST" && r.url === "/v1/assistant/invoke");
    expect(JSON.parse(posted!.body!)).toEqual({
      pluginId: "mock-download",
      tool: "search_catalog",
      args: { query: "nirvana" },
    });

    // invoke without a target is a caller error, not a request.
    const missing = await rpc.request("tools/call", {
      name: "plugin_tools",
      arguments: { action: "invoke", tool: "search_catalog" },
    });
    expect((missing.result as { isError?: boolean }).isError).toBe(true);
  });

  it("routes manage_extensions get and gallery to their read-only endpoints", async () => {
    const detail = await rpc.request("tools/call", {
      name: "manage_extensions",
      arguments: { action: "get", id: "ytdlp" },
    });
    expect(JSON.parse(toolText(detail.result)).live.searchProviders[0].key).toBe("ytdlp:youtube");
    expect(api.seen.some((r) => r.method === "GET" && r.url === "/v1/extensions/ytdlp")).toBe(true);

    const gallery = await rpc.request("tools/call", {
      name: "manage_extensions",
      arguments: { action: "gallery" },
    });
    const parsed = JSON.parse(toolText(gallery.result));
    expect(parsed.plugins.map((p: { id: string }) => p.id)).toEqual(["ytdlp", "qbittorrent"]);
    expect(api.seen.some((r) => r.method === "GET" && r.url === "/v1/extensions/gallery")).toBe(true);

    // `get` without an id is a caller error, not a request.
    const missing = await rpc.request("tools/call", {
      name: "manage_extensions",
      arguments: { action: "get" },
    });
    expect((missing.result as { isError?: boolean }).isError).toBe(true);
  });
});

describe("MCP server without a reachable app", () => {
  it("returns a friendly isError pointing at the Settings toggle", async () => {
    // A discovery file for a port nothing listens on — the crashed-app case.
    const rpc = startServer(writeDiscovery(1));
    try {
      const res = await rpc.request("tools/call", { name: "get_status", arguments: {} });
      const r = res.result as { isError?: boolean };
      expect(r.isError).toBe(true);
      expect(toolText(res.result)).toContain("AI control");
    } finally {
      rpc.kill();
    }
  });
});
