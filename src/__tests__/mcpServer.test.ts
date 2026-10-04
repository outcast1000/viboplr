// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs script, no type declarations
import { TOOLS, buildPluginProxies, parseCliArgs, versionCmp, launchCommands } from "../../mcp/viboplr-mcp.mjs";

// The MCP server is the one satellite that talks to the control API on the
// user's behalf from clients we don't control, so the protocol handshake, the
// tool listing, and — above all — that the bearer token never leaves the server
// process are pinned here against a spawned real instance.

const SERVER = join(__dirname, "..", "..", "mcp", "viboplr-mcp.mjs");
const TEST_TOKEN = "tok_secret_test_1234567890";

// The tools the retired `--tier=full` flag used to hide. They are listed
// unconditionally now; what they may change is gated in the app.
const FORMERLY_FULL_TIER = [
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
    if (req.url === "/v1/health")
      return reply(200, {
        ok: true, version: "1.0.57", profile: "default",
        writeScopes: { modifyTags: true, manageFiles: false, downloads: false },
      });
    if (req.url?.startsWith("/v1/ui")) {
      // UI verbs: echo what arrived, so a test can assert the routing.
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen[seen.length - 1].body = body;
        reply(200, { view: "home", echoed: body ? JSON.parse(body) : null });
      });
      return;
    }
    if (req.url === "/v1/tracks/file-tags" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen[seen.length - 1].body = body;
        reply(200, { requested: JSON.parse(body).trackIds.length, failed: 0, errors: [] });
      });
      return;
    }
    if (req.url === "/v1/history/rename" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen[seen.length - 1].body = body;
        const b = JSON.parse(body);
        reply(200, {
          mode: b.fromTitle ? "track" : "artist",
          from: { artist: b.fromArtist, title: b.fromTitle },
          to: { artist: b.toArtist ?? b.fromArtist, title: b.toTitle ?? b.fromTitle },
          tracksMoved: 2, playsMoved: 5, tracksMerged: 1, artistMerged: true, artistRemoved: !b.dryRun, dryRun: !!b.dryRun,
        });
      });
      return;
    }
    if (req.url === "/v1/files/move" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen[seen.length - 1].body = body;
        // The manage-files scope is off in this fixture — the app's answer.
        reply(403, { error: 'the "Manage files" assistant permission is off — enable it in Settings' });
      });
      return;
    }
    if (req.url === "/v1/downloads/plugin" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen[seen.length - 1].body = body;
        reply(200, { path: "/music/Web Artist - Web Song.m4a", indexed: true, provider: "yt-dlp" });
      });
      return;
    }
    if (req.url === "/v1/tracks/5/replace-file" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen[seen.length - 1].body = body;
        const parsed = JSON.parse(body || "{}");
        reply(200, parsed.confirm
          ? { replaced: true, trackId: 5 }
          : { staged: true, stageId: "abcdef123456.flac", current: { format: "mp3" }, replacement: { format: "flac" } });
      });
      return;
    }
    if (req.url === "/v1/downloads/plugin" && req.method === "DELETE")
      return reply(200, { cancelled: false, note: "no plugin download resolve in flight" });
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
    if (req.url?.startsWith("/v1/info/search"))
      return reply(200, [
        {
          type_id: "lyrics",
          entity: "track",
          entity_key: "track:bjork:joga",
          snippet: "…emotional landscapes…",
          track: { id: 7, title: "Jóga" },
        },
      ]);
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
          tools: [{ name: "search_catalog", description: "Search the fake catalog", inputSchema: null, readOnly: true }],
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
  it("has unique, described tools and no tier left on any of them", () => {
    const names = TOOLS.map((t: { name: string }) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of FORMERLY_FULL_TIER) expect(names).toContain(name);
    for (const t of TOOLS) {
      expect(t).not.toHaveProperty("tier");
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

  it("parses the profile from argv and env, rejecting garbage", () => {
    expect(parseCliArgs([], {})).toEqual({ profile: undefined });
    expect(parseCliArgs(["--profile", "perf"], {})).toEqual({ profile: "perf" });
    expect(parseCliArgs(["--profile=dev-3"], {})).toEqual({ profile: "dev-3" });
    expect(parseCliArgs([], { VIBOPLR_MCP_PROFILE: "perf" })).toEqual({ profile: "perf" });
    expect(() => parseCliArgs(["--bogus"], {})).toThrow(/unknown argument/);
  });

  it("still accepts the retired --tier flag, in either form, and ignores it", () => {
    // Existing client configs carry it; refusing it would stop them starting.
    expect(parseCliArgs(["--tier=full"], {})).toEqual({ profile: undefined });
    expect(parseCliArgs(["--tier", "full", "--profile", "perf"], {})).toEqual({ profile: "perf" });
    expect(parseCliArgs(["--tier=default"], {})).toEqual({ profile: undefined });
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

  it("lists every tool with no flag — including the ones --tier used to hide", async () => {
    const res = await rpc.request("tools/list");
    const names = (res.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain("search_library");
    expect(names).toContain("playback_control");
    expect(names).toContain("home_shelves");
    for (const name of FORMERLY_FULL_TIER) expect(names).toContain(name);
    // Every static tool, plus one first-class entry per plugin tool: a
    // default-config client can read a plugin's catalog (the Spotify
    // "list Daily Mix 1" case that the tier made unreachable).
    expect(names.length).toBe(TOOLS.length + 1);
    expect(names).toContain("mock-download__search_catalog");
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

  it("routes navigate and ui_control to the UI endpoints", async () => {
    await rpc.request("tools/call", { name: "navigate", arguments: { artist: "Kyuss" } });
    const nav = api.seen.find((r) => r.method === "POST" && r.url === "/v1/ui/navigate");
    expect(JSON.parse(nav!.body!)).toEqual({ artist: "Kyuss" });

    // No action = a read of the UI state.
    await rpc.request("tools/call", { name: "ui_control", arguments: {} });
    expect(api.seen.some((r) => r.method === "GET" && r.url === "/v1/ui")).toBe(true);

    await rpc.request("tools/call", { name: "ui_control", arguments: { action: "eqPanel", open: true } });
    const act = api.seen.find((r) => r.method === "POST" && r.url === "/v1/ui/action");
    expect(JSON.parse(act!.body!)).toEqual({ action: "eqPanel", open: true });
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

  it("searches the cached plugin info store with the filters mapped onto the query", async () => {
    const res = await rpc.request("tools/call", {
      name: "search_info",
      arguments: { query: "emotional landscapes", typeId: "lyrics", resolveTracks: true, limit: 10 },
    });
    expect(JSON.parse(toolText(res.result))[0].track.id).toBe(7);
    const req = api.seen.find((r) => r.url.startsWith("/v1/info/search"));
    expect(req?.url).toContain("typeId=lyrics");
    expect(req?.url).toContain("resolveTracks=true");
    expect(req?.url).toContain("limit=10");
    // The full stored value is opt-in — off unless asked for.
    expect(req?.url).not.toContain("includeValue");

    await rpc.request("tools/call", {
      name: "search_info",
      arguments: { query: "jóga", includeValue: true },
    });
    const withValue = api.seen.filter((r) => r.url.startsWith("/v1/info/search")).at(-1);
    expect(withValue?.url).toContain("includeValue=true");
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

  it("reports the installed version and its own version without touching GitHub by default", async () => {
    const res = await rpc.request("tools/call", { name: "app_version", arguments: {} });
    const info = JSON.parse(toolText(res.result));
    expect(info).toEqual({
      installed: "1.0.57",
      profile: "default",
      writeScopes: { modifyTags: true, manageFiles: false, downloads: false },
      mcp: { version: expect.any(String) },
    });
  });

  it("exposes the write tools — the app's permission switches gate them", async () => {
    const res = await rpc.request("tools/list");
    const names = (res.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    for (const name of ["write_file_tags", "manage_files", "download_track"]) {
      expect(names).toContain(name);
    }
  });

  it("posts rename_history arguments verbatim to /v1/history/rename and returns the merge report", async () => {
    const res = await rpc.request("tools/call", {
      name: "rename_history",
      arguments: { fromArtist: "Stelios Kazantzidis", toArtist: "Στέλιος Καζαντζίδης", dryRun: true },
    });
    const report = JSON.parse(toolText(res.result));
    expect(report).toMatchObject({ mode: "artist", dryRun: true, artistMerged: true, playsMoved: 5 });
    const posted = api.seen.find((r) => r.method === "POST" && r.url === "/v1/history/rename");
    expect(JSON.parse(posted!.body!)).toEqual({
      fromArtist: "Stelios Kazantzidis", toArtist: "Στέλιος Καζαντζίδης", dryRun: true,
    });
  });

  it("posts write_file_tags arguments verbatim to /v1/tracks/file-tags", async () => {
    const res = await rpc.request("tools/call", {
      name: "write_file_tags",
      arguments: { trackIds: [1, 2], tagNames: ["shoegaze"], tagMode: "add" },
    });
    expect(JSON.parse(toolText(res.result)).requested).toBe(2);
    const posted = api.seen.find((r) => r.method === "POST" && r.url === "/v1/tracks/file-tags");
    expect(JSON.parse(posted!.body!)).toEqual({ trackIds: [1, 2], tagNames: ["shoegaze"], tagMode: "add" });
  });

  it("surfaces the app's 403 for a switched-off write permission as a tool error naming Settings", async () => {
    const res = await rpc.request("tools/call", {
      name: "manage_files",
      arguments: { action: "move", moves: [{ trackId: 1, toDir: "A/B" }] },
    });
    expect((res.result as { isError?: boolean }).isError).toBe(true);
    expect(toolText(res.result)).toContain("Manage files");

    // move without moves is a caller error, not a request.
    const missing = await rpc.request("tools/call", { name: "manage_files", arguments: { action: "move" } });
    expect((missing.result as { isError?: boolean }).isError).toBe(true);
  });

  it("posts plugin downloads and routes cancel=true to DELETE", async () => {
    const res = await rpc.request("tools/call", {
      name: "download_plugin_track",
      arguments: { collectionId: 3, searchId: "s1", index: 2, subdir: "Web" },
    });
    expect(JSON.parse(toolText(res.result)).indexed).toBe(true);
    const posted = api.seen.find((r) => r.method === "POST" && r.url === "/v1/downloads/plugin");
    expect(JSON.parse(posted!.body!)).toEqual({ collectionId: 3, searchId: "s1", index: 2, subdir: "Web" });

    const cancel = await rpc.request("tools/call", {
      name: "download_plugin_track",
      arguments: { cancel: true },
    });
    expect(JSON.parse(toolText(cancel.result)).cancelled).toBe(false);
    expect(api.seen.some((r) => r.method === "DELETE" && r.url === "/v1/downloads/plugin")).toBe(true);
  });

  it("stages, then confirms, a track file replace on the track's own route", async () => {
    const staged = await rpc.request("tools/call", {
      name: "replace_track_file",
      arguments: { trackId: 5, uri: "slsk://user/file.flac" },
    });
    const stage = JSON.parse(toolText(staged.result));
    expect(stage.staged).toBe(true);
    const first = api.seen.filter((r) => r.url === "/v1/tracks/5/replace-file")[0];
    expect(JSON.parse(first.body!)).toEqual({ uri: "slsk://user/file.flac" });

    const confirmed = await rpc.request("tools/call", {
      name: "replace_track_file",
      arguments: { trackId: 5, stageId: stage.stageId, confirm: true },
    });
    expect(JSON.parse(toolText(confirmed.result)).replaced).toBe(true);
    const second = api.seen.filter((r) => r.url === "/v1/tracks/5/replace-file")[1];
    expect(JSON.parse(second.body!)).toEqual({ stageId: "abcdef123456.flac", confirm: true });
  });

  it("points the model at plugin tools and the Plugin actions switch in its instructions", async () => {
    const init = await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const result = init.result as { instructions: string; capabilities: { tools: { listChanged: boolean } } };
    expect(result.instructions).toContain("spotify-browse__get_playlist_tracks");
    expect(result.instructions).toContain("Plugin actions");
    // Nothing left telling a model to ask the user for a config flag.
    expect(result.instructions).not.toContain("tier");
    expect(result.capabilities.tools.listChanged).toBe(true);
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

describe("MCP server started with the retired --tier=full flag", () => {
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

  it("lists exactly what a flagless server lists", async () => {
    const res = await rpc.request("tools/list");
    const names = (res.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    for (const name of FORMERLY_FULL_TIER) expect(names).toContain(name);
    expect(names.length).toBe(TOOLS.length + 1);
  });

  it("lists each plugin tool as its own named tool and routes calls to it", async () => {
    const res = await rpc.request("tools/list");
    const tools = (res.result as {
      tools: Array<{ name: string; description: string; inputSchema: { type: string }; annotations?: { readOnlyHint: boolean } }>;
    }).tools;
    const proxy = tools.find((t) => t.name === "mock-download__search_catalog");
    expect(proxy).toBeDefined();
    // The plugin declared it read-only: MCP's own hint says so, and there is
    // no permission note because the app runs it without one.
    expect(proxy!.annotations).toEqual({ readOnlyHint: true });
    expect(proxy!.description).not.toContain("Plugin actions");
    // Named after the plugin, so a model (or a deferred-tool search) can find it.
    expect(proxy!.description).toContain("[Mock Download plugin] Search the fake catalog");
    expect(proxy!.description).toContain("Mock provider for testing.");
    expect(proxy!.inputSchema.type).toBe("object");

    const before = api.seen.filter((r) => r.url === "/v1/assistant/invoke").length;
    const called = await rpc.request("tools/call", {
      name: "mock-download__search_catalog",
      arguments: { query: "fugazi" },
    });
    // The tool's own return value, not plugin_tools' { result } envelope.
    expect(JSON.parse(toolText(called.result)).matches[0].id).toBe("mock-7");
    const posts = api.seen.filter((r) => r.url === "/v1/assistant/invoke");
    expect(posts.length).toBe(before + 1);
    expect(JSON.parse(posts[posts.length - 1].body!)).toEqual({
      pluginId: "mock-download",
      tool: "search_catalog",
      args: { query: "fugazi" },
    });

    const unknown = await rpc.request("tools/call", { name: "mock-download__nope", arguments: {} });
    expect(unknown.error?.code).toBe(-32602);
  });

  it("reports no tier in app_version", async () => {
    const res = await rpc.request("tools/call", { name: "app_version", arguments: {} });
    expect(JSON.parse(toolText(res.result)).mcp).not.toHaveProperty("tier");
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
    const posted = api.seen.filter((r) => r.method === "POST" && r.url === "/v1/assistant/invoke").at(-1);
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

describe("plugin tool proxies (pure)", () => {
  it("names tools <pluginId>__<tool>, labels them with the plugin, and states usage notes once", () => {
    const proxies = buildPluginProxies({
      plugins: [
        {
          pluginId: "spotify-browse",
          name: "Spotify",
          instructions: "Browse the scraped home.",
          tools: [
            { name: "status", description: "Sync state", inputSchema: null },
            {
              name: "list_playlists",
              description: "The scraped playlists",
              inputSchema: { type: "object", properties: { section: { type: "string" } } },
            },
          ],
        },
        { pluginId: "audiodb", name: "TheAudioDB", instructions: "Portraits.", tools: [] },
      ],
    });
    expect(proxies.map((p: { name: string }) => p.name)).toEqual(["spotify-browse__status", "spotify-browse__list_playlists"]);
    expect(proxies[0].description).toContain("[Spotify plugin] Sync state");
    expect(proxies[0].description).toContain("Browse the scraped home.");
    // The prose rides on the first tool only; the rest point at it.
    expect(proxies[1].description).not.toContain("Browse the scraped home.");
    expect(proxies[1].description).toContain("see spotify-browse__status");
    expect(proxies[1].inputSchema.properties.section.type).toBe("string");
    // A null schema still yields a valid MCP input schema.
    expect(proxies[0].inputSchema).toEqual({ type: "object", properties: {} });
    expect(proxies[1]).toMatchObject({ pluginId: "spotify-browse", tool: "list_playlists" });
  });

  it("marks declared read-only tools with readOnlyHint and warns on the rest", () => {
    const proxies = buildPluginProxies({
      plugins: [
        {
          pluginId: "slskd",
          name: "Soulseek",
          tools: [
            { name: "search", description: "Search the network", readOnly: true },
            { name: "download", description: "Download a file", readOnly: false },
            { name: "legacy", description: "Declares nothing" },
          ],
        },
      ],
    });
    const [search, download, legacy] = proxies;
    expect(search.annotations).toEqual({ readOnlyHint: true });
    expect(search.description).not.toContain("Plugin actions");
    // Undeclared counts as "may change things" — the app gates it the same way.
    for (const p of [download, legacy]) {
      expect(p.annotations).toEqual({ readOnlyHint: false });
      expect(p.description).toContain('Needs the "Plugin actions" permission.');
    }
  });

  it("sanitizes names and skips ones MCP can't represent or that collide", () => {
    const proxies = buildPluginProxies({
      plugins: [
        {
          pluginId: "my.plugin",
          name: "Mine",
          tools: [
            { name: "do thing", description: "d" },
            { name: "x".repeat(70), description: "too long" },
          ],
        },
      ],
    });
    expect(proxies.map((p: { name: string }) => p.name)).toEqual(["my_plugin__do_thing"]);
    expect(buildPluginProxies(null)).toEqual([]);
  });
});

describe("plugin tools when the app starts after tools/list", () => {
  it("lists only static tools, then announces list_changed once the roster is reachable", async () => {
    const api = await startFakeApi();
    const dir = writeDiscovery(1); // nothing listens yet — the app isn't running
    const rpc = startServer(dir, []);
    try {
      const init = await rpc.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      });
      expect((init.result as { capabilities: { tools: { listChanged: boolean } } }).capabilities.tools.listChanged).toBe(true);

      const first = await rpc.request("tools/list");
      const firstNames = (first.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(firstNames.length).toBe(TOOLS.length);
      expect(rpc.rawStdout()).not.toContain("notifications/tools/list_changed");

      // The app comes up (same discovery file the server re-reads per request).
      writeFileSync(
        join(dir, "default", "control-api.json"),
        JSON.stringify({ port: api.port, token: TEST_TOKEN, profile: "default", pid: 1, startedAt: "now" }),
      );
      await rpc.request("tools/call", { name: "get_status", arguments: {} });
      for (let i = 0; i < 50 && !rpc.rawStdout().includes("list_changed"); i++) await new Promise((r) => setTimeout(r, 20));
      expect(rpc.rawStdout()).toContain("notifications/tools/list_changed");

      const second = await rpc.request("tools/list");
      const secondNames = (second.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(secondNames).toContain("mock-download__search_catalog");
    } finally {
      rpc.kill();
      api.close();
    }
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
