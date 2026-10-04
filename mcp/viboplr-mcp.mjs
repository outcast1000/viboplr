#!/usr/bin/env node
// viboplr-mcp.mjs — a dependency-free stdio MCP server that shims Viboplr's
// localhost control API (see skills/viboplr-control/SKILL.md for the HTTP
// surface this mirrors). Node >= 18, no npm install needed.
//
// The server is a pure translation layer: discovery, the bearer token, and
// retry semantics live here; every capability decision stays in the Rust API.
// The tool table itself lives in tools.mjs, shared with the app's in-process
// transport (api.assistant.host) — add tools there, not here.
// The token is read from control-api.json per request and never appears in
// tool results, argv, or logs.
//
// Every tool is always listed. There used to be a `--tier` flag that hid the
// "power" tools from the model; it gated by client config rather than by
// consequence (window control and log reads sat behind it, while read-only
// plugin tools like "list my Spotify playlists" were unreachable without it),
// and it differed invisibly between clients. What an assistant may *change*
// is decided in the app instead: the per-category switches in Settings →
// AI control, enforced in Rust on every request. Plugin tools that
// declare `readOnly` always run; the rest, plus plugin context-menu actions
// and deep links, need the "Plugin actions" switch. `--tier` is still
// accepted (and ignored) so existing client configs keep starting.
//
// Usage:  node viboplr-mcp.mjs [--profile=<name>]
// Env:    VIBOPLR_MCP_PROFILE,
//         VIBOPLR_MCP_DISCOVERY_DIR (profiles dir override, mainly for tests)

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_MS, INSTRUCTIONS, PROXY_SEP, SLOW_MS, TOOLS, buildPluginProxies, runTool, toolsFor, versionCmp } from "./tools.mjs";

// Re-exported for the tests and any caller that imported them from here.
export { TOOLS, buildPluginProxies, versionCmp };

const VERSION = "0.11.0";
const BUNDLE_ID = "com.alex.viboplr";
const LATEST_PROTOCOL = "2025-06-18";
const KNOWN_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"];

const NOT_RUNNING =
  'Viboplr is not reachable — the app may not be running, or "AI control" ' +
  "is off. Call the launch_app tool to start it (the setting persists across " +
  "restarts), or ask the user to start Viboplr and enable it in Settings → General.";


// ---------------------------------------------------------------------------
// Config + discovery

const cfg = { profile: undefined };

export function parseCliArgs(argv, env = process.env) {
  const out = { profile: env.VIBOPLR_MCP_PROFILE || undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Retired: every tool is always listed now (see the header). Still
    // accepted so a config written for an older server keeps starting.
    if (a.startsWith("--tier=")) continue;
    else if (a === "--tier") i++;
    else if (a.startsWith("--profile=")) out.profile = a.slice("--profile=".length);
    else if (a === "--profile") out.profile = argv[++i];
    else throw new Error(`unknown argument: ${a} (expected --profile=<name>)`);
  }
  return out;
}

function profilesDir() {
  if (process.env.VIBOPLR_MCP_DISCOVERY_DIR) return process.env.VIBOPLR_MCP_DISCOVERY_DIR;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", BUNDLE_ID, "profiles");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), BUNDLE_ID, "profiles");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), BUNDLE_ID, "profiles");
}

// Re-read per request: an app restart rotates port + token, and the file is
// tiny. The token never leaves this function's caller (apiRequest).
function readDiscovery() {
  let dirs = [];
  try {
    dirs = readdirSync(profilesDir());
  } catch {
    throw new Error(NOT_RUNNING);
  }
  const found = [];
  for (const d of dirs) {
    try {
      const data = JSON.parse(readFileSync(join(profilesDir(), d, "control-api.json"), "utf8"));
      if (data && typeof data.port === "number" && typeof data.token === "string") {
        found.push({ profile: data.profile ?? d, data });
      }
    } catch {
      // Fire-and-forget: a profile dir without a (valid) control-api.json just isn't running the API.
    }
  }
  if (found.length === 0) throw new Error(NOT_RUNNING);
  let hit = found.find((f) => f.profile === (cfg.profile ?? "default"));
  if (!hit && !cfg.profile && found.length === 1) hit = found[0];
  if (!hit) {
    throw new Error(
      `No control API for profile "${cfg.profile ?? "default"}". ` +
        `Running profiles: ${found.map((f) => f.profile).join(", ")} — start the server with --profile=<name>.`,
    );
  }
  return hit.data;
}

// ---------------------------------------------------------------------------
// HTTP shim

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiRequest(method, path, body, { timeoutMs = DEFAULT_MS, raw = false } = {}) {
  let retries503 = 5;
  let retried504 = false;
  for (;;) {
    const { port, token } = readDiscovery();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (ctrl.signal.aborted) throw new Error(`Timed out after ${timeoutMs / 1000}s: ${method} ${path}`);
      console.error(`viboplr-mcp: ${method} ${path} failed:`, e?.message ?? e);
      throw new Error(NOT_RUNNING); // stale discovery file after a crash lands here too
    }
    clearTimeout(timer);
    if (res.status === 503 && retries503-- > 0) {
      await sleep(1000); // app still starting
      continue;
    }
    if (res.status === 504 && !retried504) {
      retried504 = true; // webview busy — the API's own guidance is retry once
      continue;
    }
    if (raw && res.ok) {
      return {
        base64: Buffer.from(await res.arrayBuffer()).toString("base64"),
        mimeType: res.headers.get("content-type") ?? "application/octet-stream",
      };
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${json.error ?? (text || res.statusText)}`);
    return json;
  }
}

// Latest *stable* release of the app on GitHub — `releases/latest` excludes
// prereleases (betas, the engine-components channel) by GitHub's own contract.
const GITHUB_REPO = "outcast1000/viboplr";

async function fetchLatestRelease() {
  const base = process.env.VIBOPLR_MCP_GITHUB_API ?? "https://api.github.com";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${base}/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `viboplr-mcp/${VERSION}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rel = await res.json();
    return {
      version: String(rel.tag_name ?? "").replace(/^v/, ""),
      url: rel.html_url,
      publishedAt: rel.published_at,
    };
  } finally {
    clearTimeout(timer);
  }
}


/**
 * Platform launch candidates for the installed app, tried in order until one
 * spawns. macOS resolves through LaunchServices (bundle id first — the process
 * name can't tell builds apart, but the id can); Windows tries the Tauri NSIS
 * install locations; Linux relies on the binary being on PATH.
 */
export function launchCommands(platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    return [
      { cmd: "open", args: ["-b", BUNDLE_ID] },
      { cmd: "open", args: ["-a", "Viboplr"] },
    ];
  }
  if (platform === "win32") {
    // win32.join explicitly: this list must be well-formed regardless of what
    // platform the (unit-tested) builder itself runs on.
    const local = env.LOCALAPPDATA ?? win32.join(env.USERPROFILE ?? homedir(), "AppData", "Local");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    return [
      { exe: win32.join(local, "Viboplr", "viboplr.exe") },
      { exe: win32.join(local, "Programs", "Viboplr", "viboplr.exe") },
      { exe: win32.join(programFiles, "Viboplr", "viboplr.exe") },
    ];
  }
  return [{ cmd: "viboplr", args: [] }];
}

function trySpawnApp() {
  const attempted = [];
  for (const candidate of launchCommands()) {
    const cmd = candidate.exe ?? candidate.cmd;
    if (candidate.exe && !existsSync(candidate.exe)) {
      attempted.push(candidate.exe);
      continue;
    }
    attempted.push(candidate.exe ?? `${candidate.cmd} ${candidate.args.join(" ")}`);
    try {
      const child = spawn(cmd, candidate.args ?? [], { detached: true, stdio: "ignore" });
      child.unref();
      return { ok: true, via: attempted[attempted.length - 1] };
    } catch (e) {
      console.error("viboplr-mcp: launch attempt failed:", e?.message ?? e);
    }
  }
  return { ok: false, attempted };
}

async function healthOrNull(timeoutMs = 3000) {
  try {
    return await apiRequest("GET", "/v1/health", undefined, { timeoutMs });
  } catch {
    // Not reachable (yet) — the caller polls; this is the probe, not a failure.
    return null;
  }
}

// ---------------------------------------------------------------------------
// launch_app — the Node half of the shared tool (tools.mjs routes it here
// through ctx.launchApp; the in-app transport has no process to spawn).
async function launchApp() {
  const before = await healthOrNull();
  if (before) return { alreadyRunning: true, version: before.version, profile: before.profile };
  const launched = trySpawnApp();
  if (!launched.ok) {
    throw new Error(
      `Couldn't find the installed app to launch (tried: ${launched.attempted.join(", ")}). ` +
        "Ask the user to start Viboplr themselves.",
    );
  }
  const waitMs = Number(process.env.VIBOPLR_MCP_LAUNCH_WAIT_MS ?? 30_000);
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    await sleep(1000);
    const health = await healthOrNull();
    if (health) {
      return {
        launched: true,
        via: launched.via,
        waitedSecs: Math.round((Date.now() - started) / 1000),
        version: health.version,
        profile: health.profile,
      };
    }
  }
  throw new Error(
    `Launched the app (via ${launched.via}) but the control API didn't answer within ${Math.round(waitMs / 1000)}s. ` +
      'Most likely "AI control" has never been enabled — ask the user to switch it on once in ' +
      "Viboplr → Settings → General; it persists from then on.",
  );
}

// The transport binding every shared tool runs with (see tools.mjs).
const ctx = {
  request: apiRequest,
  launchApp,
  fetchLatestRelease,
  mcpVersion: VERSION,
};

const MCP_TOOLS = toolsFor("mcp");

// ---------------------------------------------------------------------------
// Plugin tools as first-class MCP tools
//
// plugin_tools alone hides every plugin tool behind one generic entry: a model
// asked for "my Spotify playlists" sees nothing named Spotify or playlist, and
// clients that defer tool schemas behind a search never match it. So each
// plugin tool is also listed as `<pluginId>__<tool>`, described with its
// plugin's name. The roster comes from the running app; when it wasn't running
// at listing time (or plugins change), a later refresh announces the new set
// via notifications/tools/list_changed. A tool the plugin declared `readOnly`
// carries MCP's readOnlyHint; the app refuses the others (403) while the
// "Plugin actions" switch is off, so the description says so up front.

const ROSTER_TTL_MS = 60_000;
const proxyState = { tools: [], byName: new Map(), sig: null, at: 0, listed: false, inflight: null };


async function refreshPluginProxies({ force = false } = {}) {
  if (!force && proxyState.at && Date.now() - proxyState.at < ROSTER_TTL_MS) return;
  if (proxyState.inflight) return proxyState.inflight;
  proxyState.inflight = (async () => {
    try {
      const roster = await apiRequest("GET", "/v1/assistant/tools", undefined, { timeoutMs: 3000 });
      const tools = buildPluginProxies(roster);
      const sig = JSON.stringify(tools.map((t) => [t.name, t.description, t.inputSchema]));
      proxyState.tools = tools;
      proxyState.byName = new Map(tools.map((t) => [t.name, t]));
      proxyState.at = Date.now();
      if (sig !== proxyState.sig) {
        const hadListing = proxyState.listed;
        proxyState.sig = sig;
        // Only a client that already holds a listing needs telling.
        if (hadListing) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      }
    } catch (e) {
      // App not running / AI control off: list the static tools and retry on
      // a later call. Not an error for the caller.
      console.error("viboplr-mcp: plugin tool roster unavailable:", e?.message ?? e);
      proxyState.at = 0;
    } finally {
      proxyState.inflight = null;
    }
  })();
  return proxyState.inflight;
}

async function callPluginProxy(proxy, args) {
  const out = await apiRequest(
    "POST",
    "/v1/assistant/invoke",
    { pluginId: proxy.pluginId, tool: proxy.tool, args },
    { timeoutMs: SLOW_MS },
  );
  return out?.result ?? null;
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio (newline-delimited per the MCP stdio transport)

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function dispatch(msg) {
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return {
        protocolVersion: KNOWN_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "viboplr", version: VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list": {
      await refreshPluginProxies();
      proxyState.listed = true;
      const listed = [...MCP_TOOLS, ...proxyState.tools];
      return {
        tools: listed.map(({ name, description, inputSchema, annotations }) =>
          annotations ? { name, description, inputSchema, annotations } : { name, description, inputSchema },
        ),
      };
    }
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params ?? {};
      const tool = MCP_TOOLS.find((t) => t.name === name);
      let proxy = null;
      if (!tool && name?.includes(PROXY_SEP)) {
        proxy = proxyState.byName.get(name) ?? null;
        if (!proxy) {
          await refreshPluginProxies({ force: true });
          proxy = proxyState.byName.get(name) ?? null;
        }
      }
      if (!tool && !proxy) {
        const e = new Error(`unknown tool: ${name}`);
        e.code = -32602;
        throw e;
      }
      try {
        const out = proxy ? await callPluginProxy(proxy, args) : await runTool(tool, args, ctx);
        if (out && typeof out === "object" && Array.isArray(out.content)) return out;
        return { content: [{ type: "text", text: JSON.stringify(out ?? {}, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true };
      } finally {
        // Pick up plugins that appeared since the last listing (the app came up
        // after tools/list — launch_app — or a plugin was enabled). After the
        // call, so a launch is seen at once; announces list_changed.
        void refreshPluginProxies({ force: name === "launch_app" });
      }
    }
    default: {
      const e = new Error(`method not found: ${msg.method}`);
      e.code = -32601;
      throw e;
    }
  }
}

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    console.error("viboplr-mcp: unparseable message:", e?.message ?? e);
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  if (msg.id === undefined || msg.id === null) return; // notification — nothing to answer
  try {
    send({ jsonrpc: "2.0", id: msg.id, result: await dispatch(msg) });
  } catch (e) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: e?.code ?? -32603, message: String(e?.message ?? e) } });
  }
}

function main() {
  try {
    Object.assign(cfg, parseCliArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(`viboplr-mcp: ${e.message}`);
    process.exit(2);
  }
  console.error(`viboplr-mcp v${VERSION}${cfg.profile ? ` — profile=${cfg.profile}` : ""}`);
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) void handleLine(line);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
