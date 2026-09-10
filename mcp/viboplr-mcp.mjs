#!/usr/bin/env node
// viboplr-mcp.mjs — a dependency-free stdio MCP server that shims Viboplr's
// localhost control API (see skills/viboplr-control/SKILL.md for the HTTP
// surface this mirrors). Node >= 18, no npm install needed.
//
// The server is a pure translation layer: discovery, the bearer token, and
// retry semantics live here; every capability decision stays in the Rust API.
// The token is read from control-api.json per request and never appears in
// tool results, argv, or logs.
//
// Tiering (Option A — a flag in the client's MCP config):
//   default        — playback, search/browse, queue, playlists, likes, tags,
//                    lyrics/info, plugin catalogs and home shelves.
//   --tier=full    — adds the power verbs: plugin actions, deep links,
//                    extensions/skins, window control, logs, entity images.
// The tier changes what tools the *model sees*, not what the token authorizes.
//
// Usage:  node viboplr-mcp.mjs [--tier=default|full] [--profile=<name>]
// Env:    VIBOPLR_MCP_TIER, VIBOPLR_MCP_PROFILE,
//         VIBOPLR_MCP_DISCOVERY_DIR (profiles dir override, mainly for tests)

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "0.1.0";
const BUNDLE_ID = "com.alex.viboplr";
const LATEST_PROTOCOL = "2025-06-18";
const KNOWN_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const SLOW_MS = 95_000; // plugin catalogs / info chains can shell out to yt-dlp
const DEFAULT_MS = 30_000;

const NOT_RUNNING =
  'Viboplr is not reachable — the app may not be running, or "AI control" ' +
  "is off. Call the launch_app tool to start it (the setting persists across " +
  "restarts), or ask the user to start Viboplr and enable it in Settings → General.";

// cfg.tier is folded in at initialize time — see dispatch().
const INSTRUCTIONS = [
  "Viboplr is the user's desktop music player.",
  "Track ids from search_library/browse are library ids; playlist rows use a separate row-id space (browse kind=playlist_tracks) and those row ids are what edit_playlist remove/reorder take.",
  "Mutation commands return before UI state settles — read get_status afterwards for the truth.",
  "External/plugin tracks resolve their stream at play time; get_status can show the previous track for 10–20s after playing one. Wait and re-read before concluding a play failed.",
  "If tools report the app unreachable, ask the user to start Viboplr and enable Settings → General → AI control.",
].join(" ");

// ---------------------------------------------------------------------------
// Config + discovery

const cfg = { tier: "default", profile: undefined };

export function parseCliArgs(argv, env = process.env) {
  const out = {
    tier: env.VIBOPLR_MCP_TIER ?? "default",
    profile: env.VIBOPLR_MCP_PROFILE || undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--tier=")) out.tier = a.slice("--tier=".length);
    else if (a === "--tier") out.tier = argv[++i];
    else if (a.startsWith("--profile=")) out.profile = a.slice("--profile=".length);
    else if (a === "--profile") out.profile = argv[++i];
    else throw new Error(`unknown argument: ${a} (expected --tier=default|full, --profile=<name>)`);
  }
  if (out.tier !== "default" && out.tier !== "full") {
    throw new Error(`--tier must be "default" or "full", got "${out.tier}"`);
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
        bytes: Buffer.from(await res.arrayBuffer()),
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

export function versionCmp(a, b) {
  const pa = String(a).replace(/^v/, "").split(".");
  const pb = String(b).replace(/^v/, "").split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d;
  }
  return 0;
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

function qs(params) {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (pairs.length === 0) return "";
  return "?" + new URLSearchParams(pairs.map(([k, v]) => [k, String(v)])).toString();
}

function need(args, keys, context) {
  for (const k of keys) {
    if (args[k] === undefined) throw new Error(`"${k}" is required for ${context}`);
  }
}

// ---------------------------------------------------------------------------
// Tool table — JSON Schema helpers

const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const bool = (description) => ({ type: "boolean", description });
const numArr = (description) => ({ type: "array", items: { type: "number" }, description });
const strArr = (description) => ({ type: "array", items: { type: "string" }, description });
const en = (values, description) => ({ type: "string", enum: values, description });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export const TOOLS = [
  // -- default tier ---------------------------------------------------------
  {
    name: "search_library",
    description:
      "Full-text search the music library. Returns raw rows (snake_case); a track row's `id` is the library id every other tool takes.",
    inputSchema: obj(
      {
        query: str("Search text"),
        type: en(["all", "track", "artist", "album", "tag"], "What to search (default all)"),
        limit: num("Max results (default 20)"),
      },
      ["query"],
    ),
    run: ({ query, type, limit }) => apiRequest("GET", `/v1/search${qs({ q: query, type, limit })}`),
  },
  {
    name: "browse",
    description:
      "Read library structure: one track, an artist's tracks/albums, an album's tracks (in track order — prefer this over search for queuing albums), a tag's tracks, all tags, saved playlists, one playlist's tracks (returns playlist ROW ids — a different id space, used by edit_playlist remove/reorder), curated picks (liked / never_played / forgotten_favorites), or listening history (recent / most_played).",
    inputSchema: obj(
      {
        kind: en(
          [
            "track",
            "artist_tracks",
            "artist_albums",
            "album_tracks",
            "tag_tracks",
            "tags",
            "playlists",
            "playlist_tracks",
            "liked",
            "never_played",
            "forgotten_favorites",
            "recent",
            "most_played",
          ],
          "What to browse",
        ),
        id: num("Entity id — required for track / artist_* / album_tracks / tag_tracks / playlist_tracks"),
        limit: num("Max rows (lists only)"),
        offset: num("Offset (kind=tags only)"),
      },
      ["kind"],
    ),
    run: ({ kind, id, limit, offset }) => {
      const withId = (path) => {
        need({ id }, ["id"], `kind=${kind}`);
        return apiRequest("GET", path);
      };
      switch (kind) {
        case "track":
          return withId(`/v1/tracks/${id}`);
        case "artist_tracks":
          return withId(`/v1/artists/${id}/tracks`);
        case "artist_albums":
          return withId(`/v1/artists/${id}/albums`);
        case "album_tracks":
          return withId(`/v1/albums/${id}/tracks`);
        case "tag_tracks":
          return withId(`/v1/tags/${id}/tracks`);
        case "tags":
          return apiRequest("GET", `/v1/tags${qs({ limit, offset })}`);
        case "playlists":
          return apiRequest("GET", "/v1/playlists");
        case "playlist_tracks":
          return withId(`/v1/playlists/${id}/tracks`);
        case "liked":
        case "never_played":
        case "forgotten_favorites":
          return apiRequest("GET", `/v1/picks${qs({ kind, limit })}`);
        case "recent":
        case "most_played":
          return apiRequest("GET", `/v1/history${qs({ kind, limit })}`);
        default:
          throw new Error(`unknown browse kind: ${kind}`);
      }
    },
  },
  {
    name: "get_status",
    description:
      "What is playing right now: playing flag, position, volume, queue index/length, and the current track (with its libraryId when it is a library track).",
    inputSchema: obj({}),
    run: () => apiRequest("GET", "/v1/status"),
  },
  {
    name: "get_queue",
    description:
      "The live play queue: index, repeat mode, and tracks with their queue positions. Each track's `libraryId` is the id other tools take (null for external entries).",
    inputSchema: obj({}),
    run: () => apiRequest("GET", "/v1/queue"),
  },
  {
    name: "playback_control",
    description:
      "Transport: play/pause (idempotent `play` boolean), next/prev/stop, seek, volume, repeat mode. Read get_status afterwards for the settled state.",
    inputSchema: obj({
      play: bool("true = playing, false = paused (idempotent)"),
      action: en(["next", "prev", "stop"], "One-shot transport action"),
      seekSecs: num("Seek to this position in seconds"),
      volume: num("0..1"),
      mode: en(["normal", "repeat-all", "repeat-one"], "Repeat mode"),
    }),
    run: (args) => apiRequest("POST", "/v1/playback", args),
  },
  {
    name: "play_tracks",
    description: "Replace the queue with these library track ids and start playing.",
    inputSchema: obj(
      {
        trackIds: numArr("Library track ids, in play order"),
        contextName: str("Optional context label shown in the queue banner"),
      },
      ["trackIds"],
    ),
    run: (args) => apiRequest("POST", "/v1/queue/play", args),
  },
  {
    name: "edit_queue",
    description:
      "Edit the live queue without replacing it: add (to end) / add_next, remove by queue positions, clear, one-shot randomize, or jump to a position. Positions come from get_queue. Duplicates are skipped and counted unless allowDuplicates.",
    inputSchema: obj(
      {
        action: en(["add", "add_next", "remove", "clear", "randomize", "jump"], "What to do"),
        trackIds: numArr("Library track ids (add / add_next)"),
        indices: numArr("Queue positions (remove)"),
        index: num("Queue position (jump)"),
        allowDuplicates: bool("Add tracks already in the queue instead of skipping them"),
      },
      ["action"],
    ),
    run: ({ action, trackIds, indices, index, allowDuplicates }) => {
      switch (action) {
        case "add":
        case "add_next":
          need({ trackIds }, ["trackIds"], `action=${action}`);
          return apiRequest("POST", "/v1/queue/tracks", {
            trackIds,
            mode: action === "add_next" ? "next" : "end",
            allowDuplicates,
          });
        case "remove":
          need({ indices }, ["indices"], "action=remove");
          return apiRequest("DELETE", "/v1/queue/tracks", { indices });
        case "clear":
          return apiRequest("POST", "/v1/queue/clear", {});
        case "randomize":
          return apiRequest("POST", "/v1/queue/randomize", {});
        case "jump":
          need({ index }, ["index"], "action=jump");
          return apiRequest("POST", "/v1/queue/jump", { index });
        default:
          throw new Error(`unknown queue action: ${action}`);
      }
    },
  },
  {
    name: "start_radio",
    description:
      "Build a ~30-track radio station from a seed track (library id, or title+artist for external tracks), replace the queue and play it.",
    inputSchema: obj({
      trackId: num("Seed library track id"),
      title: str("Seed title (when no trackId)"),
      artistName: str("Seed artist (with title)"),
    }),
    run: (args) => apiRequest("POST", "/v1/radio", args),
  },
  {
    name: "play_playlist",
    description:
      "Play a saved playlist (replaces the queue), or enqueue it at the end / next without replacing. Playlist ids come from browse kind=playlists; system/auto playlists can be played too.",
    inputSchema: obj(
      {
        playlistId: num("Playlist id"),
        mode: en(["play", "end", "next"], "play = replace queue (default); end/next = enqueue"),
        allowDuplicates: bool("For enqueue: add tracks already in the queue"),
      },
      ["playlistId"],
    ),
    run: ({ playlistId, mode = "play", allowDuplicates }) =>
      mode === "play"
        ? apiRequest("POST", `/v1/playlists/${playlistId}/play`, {})
        : apiRequest("POST", `/v1/playlists/${playlistId}/enqueue`, { mode, allowDuplicates }),
  },
  {
    name: "edit_playlist",
    description:
      "Create or edit a USER playlist (system/auto playlists are refused): create, add_tracks (library track ids), remove_tracks / reorder (playlist ROW ids from browse kind=playlist_tracks — reorder takes the full permutation), rename.",
    inputSchema: obj(
      {
        action: en(["create", "add_tracks", "remove_tracks", "reorder", "rename"], "What to do"),
        playlistId: num("Playlist id (everything except create)"),
        name: str("Playlist name (create / rename)"),
        description: str("Playlist description (create / rename)"),
        trackIds: numArr("Library track ids (create / add_tracks)"),
        playlistTrackIds: numArr("Playlist ROW ids (remove_tracks)"),
        orderedIds: numArr("Full permutation of ROW ids (reorder)"),
        allowDuplicates: bool("add_tracks: add tracks the playlist already has"),
      },
      ["action"],
    ),
    run: ({ action, playlistId, name, description, trackIds, playlistTrackIds, orderedIds, allowDuplicates }) => {
      if (action !== "create") need({ playlistId }, ["playlistId"], `action=${action}`);
      switch (action) {
        case "create":
          need({ name }, ["name"], "action=create");
          return apiRequest("POST", "/v1/playlists", { name, description, trackIds });
        case "add_tracks":
          need({ trackIds }, ["trackIds"], "action=add_tracks");
          return apiRequest("POST", `/v1/playlists/${playlistId}/tracks`, { trackIds, allowDuplicates });
        case "remove_tracks":
          need({ playlistTrackIds }, ["playlistTrackIds"], "action=remove_tracks");
          return apiRequest("DELETE", `/v1/playlists/${playlistId}/tracks`, { playlistTrackIds });
        case "reorder":
          need({ orderedIds }, ["orderedIds"], "action=reorder");
          return apiRequest("PUT", `/v1/playlists/${playlistId}/order`, { orderedIds });
        case "rename":
          need({ name }, ["name"], "action=rename");
          return apiRequest("PATCH", `/v1/playlists/${playlistId}`, { name, description });
        default:
          throw new Error(`unknown playlist action: ${action}`);
      }
    },
  },
  {
    name: "set_like",
    description:
      "Set the like state of a track, artist, album, or tag: 1 = liked, -1 = disliked, 0 = neutral. Tracks/albums are addressed by title (+ artistName); artists/tags by name. Works for any track, library or not.",
    inputSchema: obj(
      {
        kind: en(["track", "artist", "album", "tag"], "Entity kind"),
        likeState: num("1 liked, 0 neutral, -1 disliked"),
        title: str("Track or album title (kind=track|album)"),
        name: str("Artist or tag name (kind=artist|tag)"),
        artistName: str("Artist (for track/album)"),
        albumTitle: str("Album (for track, optional)"),
      },
      ["kind", "likeState"],
    ),
    run: (args) => apiRequest("POST", "/v1/likes", args),
  },
  {
    name: "edit_track_tags",
    description:
      "Add/remove database tags on a library track (files are never touched). Returns the final tag set.",
    inputSchema: obj(
      {
        trackId: num("Library track id"),
        add: strArr("Tag names to add"),
        remove: strArr("Tag names to remove"),
      },
      ["trackId"],
    ),
    run: ({ trackId, add, remove }) => apiRequest("POST", `/v1/tracks/${trackId}/tags`, { add, remove }),
  },
  {
    name: "get_lyrics",
    description:
      "Lyrics for a track — omit title/artistName to use what's playing. Fresh cache is instant; otherwise the lyrics provider chain runs (can take a while). Synced lyrics carry per-line timestamps.",
    inputSchema: obj({
      title: str("Track title (omit to use the playing track)"),
      artistName: str("Artist (with title)"),
    }),
    run: (args) => apiRequest("GET", `/v1/lyrics${qs(args)}`, undefined, { timeoutMs: SLOW_MS }),
  },
  {
    name: "get_entity_info",
    description:
      "Info about a track/artist/album/tag (bio, similar, reviews, top tracks…). Without typeId: instant, lists the registered info types plus every cached value. With typeId (e.g. artist_bio, similar_artists): fetches that one live through the plugin provider chain (can take a while).",
    inputSchema: obj(
      {
        kind: en(["track", "artist", "album", "tag"], "Entity kind"),
        name: str("Artist/tag name (kind=artist|tag)"),
        title: str("Track/album title (kind=track|album)"),
        artistName: str("Artist (for track/album)"),
        typeId: str("Fetch this one info type live (ids come from the no-typeId call)"),
      },
      ["kind"],
    ),
    run: ({ kind, name, title, artistName, typeId }) =>
      typeId
        ? apiRequest("POST", "/v1/info/fetch", { kind, name, title, artistName, typeId }, { timeoutMs: SLOW_MS })
        : apiRequest("GET", `/v1/info/entity${qs({ kind, name, title, artistName })}`),
  },
  {
    name: "launch_app",
    description:
      "Start Viboplr when it isn't running: launches the installed app and waits (up to ~30s) for its control API to answer. Requires the user to have enabled Settings → General → AI control at least once — the setting persists, so a launched app brings the API up on its own. Already running? Returns immediately with alreadyRunning. Never quits or restarts the app.",
    inputSchema: obj({}),
    run: async () => {
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
    },
  },
  {
    name: "collections",
    description:
      "The user's music collections (local folders, Subsonic servers, subscribed manifests). action=list shows each with kind, enabled, sync status/errors and track counts; action=rescan re-syncs one with what's on disk / on the server — it runs in the background, so confirm by re-listing (last_synced_at moves) or searching for the expected tracks. full=true additionally re-reads every file's tags (expensive — only for external tag edits); don't rescan speculatively. There is no verb to add or remove a collection — that stays in the app's Settings.",
    inputSchema: obj(
      {
        action: en(["list", "rescan"], "What to do"),
        collectionId: num("Collection id from action=list (rescan)"),
        full: bool("Full rescan: re-read every file's tags, bypassing the modified-time fast path (rescan)"),
      },
      ["action"],
    ),
    run: ({ action, collectionId, full }) => {
      if (action === "list") return apiRequest("GET", "/v1/collections");
      need({ collectionId }, ["collectionId"], "action=rescan");
      return apiRequest("POST", `/v1/collections/${collectionId}/rescan`, { full });
    },
  },
  {
    name: "app_version",
    description:
      "The running Viboplr's version and profile, plus this MCP server's own version and tool tier (`mcp.tier` — \"default\" hides the power tools; \"full\" is enabled per client with --tier=full). With checkLatest=true, also looks up the newest stable release of outcast1000/viboplr on GitHub (releases/latest — betas excluded) and reports whether the app is up to date. Report-only: updates are installed from inside the app (Settings → General), never from here.",
    inputSchema: obj({
      checkLatest: bool("Also fetch the latest GitHub release and compare"),
    }),
    run: async ({ checkLatest }) => {
      const health = await apiRequest("GET", "/v1/health");
      const out = {
        installed: health.version,
        profile: health.profile,
        mcp: { version: VERSION, tier: cfg.tier },
      };
      if (!checkLatest) return out;
      try {
        out.latest = await fetchLatestRelease();
        out.upToDate = versionCmp(health.version, out.latest.version) >= 0;
      } catch (e) {
        console.error("viboplr-mcp: latest-release lookup failed:", e?.message ?? e);
        out.latestError = `Could not look up the latest release on GitHub: ${e?.message ?? e}`;
      }
      return out;
    },
  },
  {
    name: "catalog_search",
    description:
      "Search external catalogs (YouTube, Spotify, TIDAL…) through their plugins. action=providers lists what's installed; action=search runs a query (SLOW — up to a minute) and returns a session-cached searchId + indexed tracks for catalog_play. External results have no library ids.",
    inputSchema: obj(
      {
        action: en(["providers", "search"], "List providers or run a search"),
        provider: str("Provider key from action=providers (search)"),
        query: str("Search text (search)"),
        limit: num("Max results (search)"),
      },
      ["action"],
    ),
    run: ({ action, provider, query, limit }) => {
      if (action === "providers") return apiRequest("GET", "/v1/search/providers");
      need({ provider, query }, ["provider", "query"], "action=search");
      return apiRequest("POST", "/v1/search/plugin", { provider, query, limit }, { timeoutMs: SLOW_MS });
    },
  },
  {
    name: "catalog_play",
    description:
      "Play or enqueue tracks from a previous catalog_search, by searchId + indices. Results are cached per app session (last 8 searches) — an expired searchId means re-run the search. Playback resolves through the plugin's stream resolver, so get_status may lag 10–20s.",
    inputSchema: obj(
      {
        searchId: str("From catalog_search"),
        indices: numArr("Result indices (omit for all)"),
        mode: en(["play", "end", "next"], "play = replace queue (default)"),
        allowDuplicates: bool("Enqueue duplicates instead of skipping"),
      },
      ["searchId"],
    ),
    run: (args) => apiRequest("POST", "/v1/queue/play-search", args),
  },
  {
    name: "home_shelves",
    description:
      "Plugin home shelves (e.g. Spotify Daily Mixes / Made For You). action=list shows the shelves; action=fetch loads one shelf's cards (SLOW, returns a session-cached fetchId); action=play plays a card exactly as the Home page would (lazy cards resolve first — SLOW; partial cards start immediately and backfill).",
    inputSchema: obj(
      {
        action: en(["list", "fetch", "play"], "What to do"),
        shelf: str("Shelf key from action=list (fetch)"),
        fetchId: str("From action=fetch (play)"),
        index: num("Card index (play)"),
        limit: num("Max cards (fetch)"),
      },
      ["action"],
    ),
    run: ({ action, shelf, fetchId, index, limit }) => {
      switch (action) {
        case "list":
          return apiRequest("GET", "/v1/home/shelves");
        case "fetch":
          need({ shelf }, ["shelf"], "action=fetch");
          return apiRequest("POST", "/v1/home/shelf", { shelf, limit }, { timeoutMs: SLOW_MS });
        case "play":
          need({ fetchId, index }, ["fetchId", "index"], "action=play");
          return apiRequest("POST", "/v1/home/play", { fetchId, index }, { timeoutMs: SLOW_MS });
        default:
          throw new Error(`unknown shelves action: ${action}`);
      }
    },
  },

  // -- full tier ------------------------------------------------------------
  {
    name: "plugin_actions",
    tier: "full",
    description:
      "Plugin-contributed context-menu verbs (e.g. yt-dlp's \"Watch YouTube video\"). action=list shows the enabled verbs for a target kind; action=invoke runs one — fire-and-forget: effects appear in the app, not the response.",
    inputSchema: obj(
      {
        action: en(["list", "invoke"], "What to do"),
        target: en(["track", "album", "artist", "multi-track", "playlist"], "Target kind (list)"),
        actionId: str("Action id from list (invoke)"),
        pluginId: str("Owning plugin (invoke, optional)"),
        kind: str("Target kind (invoke)"),
        trackId: num("Library track id target (invoke)"),
        title: str("Metadata target title (invoke)"),
        artistName: str("Metadata target artist (invoke)"),
        trackIds: numArr("Multi-track target (invoke)"),
      },
      ["action"],
    ),
    run: ({ action, target, ...rest }) => {
      if (action === "list") return apiRequest("GET", `/v1/actions${qs({ target })}`);
      need(rest, ["actionId"], "action=invoke");
      return apiRequest("POST", "/v1/actions/invoke", rest);
    },
  },
  {
    name: "plugin_deep_link",
    tier: "full",
    description:
      "Deliver a viboplr://plugin/{id}/{path} deep link to one plugin (scoped, never broadcast) — e.g. completing an auth flow the plugin documents.",
    inputSchema: obj(
      {
        pluginId: str("Target plugin id"),
        path: str("Link path after the plugin id"),
      },
      ["pluginId"],
    ),
    run: ({ pluginId, path }) => apiRequest("POST", `/v1/plugins/${pluginId}/deep-link`, { path }),
  },
  {
    name: "manage_extensions",
    tier: "full",
    description:
      "List installed plugins/skins + pending updates, enable/disable a plugin, start a background update check (poll list after ~15s), or apply a skin by id or name. Installing/deleting extensions is a permanent non-goal of the API — never suggest working around it.",
    inputSchema: obj(
      {
        action: en(["list", "set_enabled", "check_updates", "apply_skin"], "What to do"),
        id: str("Plugin id (set_enabled) or skin id (apply_skin)"),
        enabled: bool("set_enabled: the new state"),
        name: str("Skin name, case-insensitive (apply_skin alternative to id)"),
      },
      ["action"],
    ),
    run: ({ action, id, enabled, name }) => {
      switch (action) {
        case "list":
          return apiRequest("GET", "/v1/extensions");
        case "set_enabled":
          need({ id, enabled }, ["id", "enabled"], "action=set_enabled");
          return apiRequest("POST", `/v1/extensions/${id}/enabled`, { enabled });
        case "check_updates":
          return apiRequest("POST", "/v1/extensions/check-updates", {});
        case "apply_skin":
          if (id === undefined && name === undefined) throw new Error('"id" or "name" is required for action=apply_skin');
          return apiRequest("POST", "/v1/skins/apply", { id, name });
        default:
          throw new Error(`unknown extensions action: ${action}`);
      }
    },
  },
  {
    name: "window_control",
    tier: "full",
    description:
      "Read or set the app window: visible/minimized/maximized/fullscreen/mini(-player)/focus, all idempotent booleans. No arguments = read. The response snapshot lags OS animation — re-read ~2s later for the settled state. Entering fullscreen needs a current track.",
    inputSchema: obj({
      visible: bool("Show/hide"),
      minimized: bool("Minimize/restore"),
      maximized: bool("Maximize/restore"),
      fullscreen: bool("Fullscreen on/off"),
      mini: bool("Mini player on/off"),
      focus: bool("Bring to front"),
    }),
    run: (args) =>
      Object.keys(args).length === 0 ? apiRequest("GET", "/v1/window") : apiRequest("POST", "/v1/window", args),
  },
  {
    name: "logs",
    tier: "full",
    description:
      "App logs, home-dir scrubbed: action=tail is the backend log (last 200 lines), action=frontend is the always-on in-memory ring buffers — uncaught errors, stream-resolver activity, plugin api.log lines, and recent toasts (check the last two after a fire-and-forget action seems to do nothing: its failure surfaces only there), action=configure sets file/debug logging (file logging applies on next launch). Consent rule: show the user before posting log contents anywhere public.",
    inputSchema: obj(
      {
        action: en(["tail", "frontend", "configure"], "What to do"),
        enabled: bool("configure: file logging on/off (next launch)"),
        debug: bool("configure: frontend debug logging (live)"),
      },
      ["action"],
    ),
    run: ({ action, enabled, debug }) => {
      switch (action) {
        case "tail":
          return apiRequest("GET", "/v1/logs");
        case "frontend":
          return apiRequest("GET", "/v1/logs/frontend");
        case "configure":
          return apiRequest("POST", "/v1/logs", { enabled, debug });
        default:
          throw new Error(`unknown logs action: ${action}`);
      }
    },
  },
  {
    name: "get_entity_image",
    tier: "full",
    description:
      "The cached album cover / artist portrait / tag art as an image. Not cached yet (404)? Call with resolve=true to run the image provider chain (async), then retry after a few seconds.",
    inputSchema: obj(
      {
        kind: en(["artist", "album", "tag"], "Image kind"),
        name: str("Entity name (album title for kind=album)"),
        artistName: str("Album artist (kind=album only)"),
        resolve: bool("Start an async resolve instead of reading the cache"),
      },
      ["kind", "name"],
    ),
    run: async ({ kind, name, artistName, resolve }) => {
      if (resolve) return apiRequest("POST", `/v1/images/${kind}`, { name, artistName });
      const { bytes, mimeType } = await apiRequest("GET", `/v1/images/${kind}${qs({ name, artistName })}`, undefined, {
        raw: true,
      });
      return { content: [{ type: "image", data: bytes.toString("base64"), mimeType }] };
    },
  },
];

function activeTools() {
  return TOOLS.filter((t) => cfg.tier === "full" || t.tier !== "full");
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
      const tierNote =
        cfg.tier === "full"
          ? "This server runs at the full tool tier."
          : "This server runs at the default tool tier — the power tools (plugin actions, deep links, extensions/skins, window control, logs, entity images) are not exposed; the user can enable them by adding --tier=full to this server's entry in their MCP client config.";
      return {
        protocolVersion: KNOWN_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "viboplr", version: VERSION },
        instructions: `${INSTRUCTIONS} ${tierNote}`,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: activeTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params ?? {};
      const tool = activeTools().find((t) => t.name === name);
      if (!tool) {
        const e = new Error(`unknown tool: ${name}`);
        e.code = -32602;
        throw e;
      }
      try {
        const out = await tool.run(args);
        if (out && typeof out === "object" && Array.isArray(out.content)) return out;
        return { content: [{ type: "text", text: JSON.stringify(out ?? {}, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true };
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
  console.error(`viboplr-mcp v${VERSION} — tier=${cfg.tier}${cfg.profile ? ` profile=${cfg.profile}` : ""}`);
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
