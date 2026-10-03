# LLM plugin for Viboplr: design and phased plan

## Context
Ollama (Homebrew, v0.35.1) is now the only LLM runtime on this Mac. Right now the only LLM path
runs one way: an outside assistant controls the app through the control API / MCP server
(`mcp/viboplr-mcp.mjs`). Nothing inside the app calls a model. The goal is a **Viboplr plugin**
(plugin-first rule: not core) that uses an LLM.

The user picked all four features (Ask playlists, metadata cleanup, tag normalization, lyrics
translate/meaning) and added **downloading, filling albums, upgrading tracks and fetching more info
from the web**. Endpoint: **local plus any OpenAI-compatible endpoint** (cloud, LAN).

The added features change the shape of the plugin. It's no longer a set of single-prompt features.
It's an **agent**: the model plans and calls the app's existing composition APIs as tools, and the
user confirms anything that writes or downloads.

## Architecture: plugin `llm` (new external repo `outcast1000/viboplr-llm`)

### 1. Model client (shared by every feature)
- Calls `POST {baseURL}/chat/completions` through `api.network.fetch(url, { method, headers, body, timeoutMs })`,
  OpenAI-compatible, so Ollama, LM Studio, llama.cpp, OpenAI, OpenRouter and Anthropic-compat
  endpoints all work. Supports `tools` (function calling) and JSON-schema `response_format`.
- Settings view (`api.ui.setViewData` + `setViewHeader` status): base URL, API key, model (pulled
  from `/v1/models`), a "test connection" button, and an optional separate "fast model" for small jobs.
- The API key goes in `api.storage`. It never appears in logs or diagnostic bundles.
- `network.fetch` doesn't stream, so the UI shows a spinner plus an elapsed counter (same rule as the
  download modal).

### 2. Agent loop: reuses the MCP server's tool catalog and the control API
The agent doesn't get a hand-written tool set. It gets **the same tools an MCP client sees**,
executed by **the same control-API handlers**. There's one catalog, one set of scope gates, and
nothing to keep in sync.

How the existing pieces fit:
- `mcp/viboplr-mcp.mjs` exports `TOOLS`. Each entry has `{ name, description, inputSchema, run }`,
  and every `run` goes through one seam, `apiRequest(method, path, body)` → `http://127.0.0.1:{port}`
  with a bearer token. The MCP server instructions (search/tagging/renaming recipes) are prose the
  agent can reuse as its system prompt.
- `src-tauri/src/control_api.rs` is an axum router behind `auth_middleware`, with
  `handle_*` / `handle_bridge_*` routes. Write scopes (`assistant_write.rs`, "Plugin actions",
  file writes, …) are checked inside the handlers.
- `src/hooks/useControlApi.ts` answers bridged verbs with the canonical actions.
- Plugin tools already appear as `<pluginId>__<tool>` through `plugin_tools`, so slskd's
  `upgradeFor`, yt-dlp, qBittorrent and so on come along for free.

Host changes that make the catalog reusable from inside the app:
1. **Split the MCP script.** Move `TOOLS`, the schema helpers and the instructions into
   `mcp/tools.mjs`, a pure module where `run(args, apiRequest)` takes the request function as a
   parameter. `viboplr-mcp.mjs` keeps only the stdio transport, discovery and token, and binds
   `apiRequest` to HTTP. Behaviour is unchanged for MCP clients. Both files stay in
   `bundle.resources`.
2. **In-process control API.** Add a Tauri command `control_api_call(method, path, body)` that sends
   the request through the **same axum router** (`tower::ServiceExt::oneshot`), skipping the TCP
   socket and the token but **not** the handlers' scope checks. It still requires
   **Settings → AI control** to be on: the in-app agent is "AI controlling the app", so it falls
   under the same consent.
3. **Plugin API** `api.assistant.host`:
   - `listTools()` returns the catalog (name, description, inputSchema, readOnly) plus the existing
     plugin-tool roster.
   - `instructions()` returns the recipes prose.
   - `invoke(name, args)` runs `TOOLS[name].run(args, inProcessApiRequest)`.

   The frontend imports `mcp/tools.mjs` directly. New permission: `assistant:host`, fail-closed in
   `src/pluginWorker/permissions.ts`, listed in the consent UI.

**New MCP tools reach the plugin automatically.** The catalog ships with the *app*, so a tool added
to `mcp/tools.mjs` appears in `listTools()` on the next app release, with no plugin release. Two
catalog fields make that safe:
- `readOnly: boolean` on every host tool, like plugin tools. If it's missing, the tool is treated
  as a write, so the plugin asks for confirmation (fail-safe).
- `categories: string[]`, e.g. `library-read`, `playback`, `catalog`, `download`, `tags`, `info`.
  Features pick tools **by category, not by name**, so a new tool tagged `catalog` automatically
  joins every feature that uses catalogs.

A unit test fails if any `TOOLS` entry is missing `readOnly` or `categories`. An HTTP route with no
`TOOLS` entry stays invisible here, exactly as it is to MCP clients today. The plugin checks
`listTools()` before relying on a specific tool, and declares `minAppVersion` for any it requires.

What the plugin adds on top:
- **Tool subsets per feature, chosen by category.** Local 7–14B models get confused by ~40 tools,
  so each feature passes only the categories it needs. Ask: `library-read` + `playback`. Fill album:
  `info` + `catalog` + `download`. Free chat with a cloud model gets everything.
- **Confirm before any non-readOnly call.** The chat UI shows the pending call (tool + args) and runs
  it only after the user approves. It's the same idea as Claude Code's permission prompt, layered on
  top of the host's scopes.
- **`web_fetch(url)`**: the only plugin-local tool (`api.network.fetch` + HTML strip,
  `network:*`). The control API has no general web fetch and shouldn't get one.
- **Grounding.** The library tools return real ids, so the model acts on ids it read, never on names
  it made up. Tool results are passed back verbatim.

Downloads and upgrades go through the existing `download_track` / `download_plugin_track` /
`replace_track_file` verbs, which already follow the rules: source-faithful, two-phase replace, no
batch queue.

### 3. Features on top of the client and agent

| Feature | Entry point | Mode |
|---|---|---|
| **Ask** ("rainy Sunday 70s soul, nothing I played this week") | Cmd+K search provider (`api.search`) + chat view | agent → library candidates → propose play (radio-style via `playWithBackfill`) |
| **Fill album** | context menu on `album` / album detail → "Find missing tracks" | `get_info` tracklist vs library → `search_catalog` per gap → propose download set |
| **Upgrade** ("upgrade low-bitrate tracks of this artist") | context menu `artist` / `multi-track` + chat | library bitrate/format read → slskd/qbt tools or download providers → propose |
| **Download** ("get Kind of Blue") | chat | catalog search → pick best source → propose `download-album` |
| **More info** | chat + new info type "AI notes" on artist/album/track | `get_info` + `web_fetch` (Wikipedia, Discogs, Bandcamp) → summary with **source links**, cached in `information_values` |
| **Metadata cleanup** | context menu `track` / `multi-track` | single structured prompt (fast model) → diff review → `bulkUpdateTracks` |
| **Tag normalization / mood tags** | plugin view "Tags" tab | scan `getTags` → cluster duplicates + suggest per-artist mood/era → reviewed diff |
| **Lyrics translate / meaning** | info type on Track detail | reads cached lyrics (`informationTypes.getValue`) → generated once, cached |
| **LLM as a service** | assistant tool `llm__complete` (readOnly) | other plugins reuse the configured model through `api.assistant.invoke` |

The Home shelf and Now-Playing items have 5s budgets, so they can only serve precomputed snapshots
from `api.storage`. None in v1.

## Host prerequisites (core repo)
0. **Catalog reuse:** the `mcp/tools.mjs` split + `control_api_call` + `api.assistant.host`
   (section 2). Tests: `TOOLS` snapshot unchanged after the split; `control_api_call` gets
   the same scope refusals as HTTP; permission table entry is fail-closed.
1. **User-configured network hosts for worker plugins.** This is the open item from the
   worker-runtime work. It's needed for the cloud/LAN endpoint the user chose. Shape: plugin
   settings declare a "user host" field; on save, the host grants `network:<that host>` after a
   consent prompt. Files: `src/pluginWorker/permissions.ts`, consent UI in `PluginInstallModal.tsx`
   / `ExtensionsView.tsx`, Rust redirect scope.
2. **`network:*` for `web_fetch`**: the permission vocabulary already supports it; just declare it
   so it shows in the consent list.
3. Nice-to-have, later: streaming `network.fetch` for token-by-token chat.

## Phases
0. Host: catalog reuse (prerequisite 0) + user-configured hosts (prerequisite 1), with tests.
1. Plugin skeleton: client, settings view, connection test, `llm__complete` tool.
2. Metadata cleanup + lyrics translate/meaning. These are single-prompt features that prove
   schema → review → write.
3. Agent loop + chat view + **Ask** (Cmd+K).
4. Fill album, Download, Upgrade (agent tools over search/assistant/requestAction).
5. More info (`web_fetch` + cited summaries) + tag normalization.
6. Gallery registration (index.json, minAppVersion = the release carrying phase 0).

## Verification
- **Unit (pure):** prompt builders, JSON-schema validation, grounding re-resolver, proposal →
  canonical-call mapping, agent loop with a mocked model (scripted tool calls, including a
  hallucinated track that must be dropped).
- **Live:** `dev-3` profile + `devPluginPath`; Ollama `qwen3:14b` locally plus one cloud endpoint.
  - Ask query: every queued track exists in the library.
  - Fill album on a partial album: the download modal opens with only the missing tracks.
  - Cleanup on a yt-dlp import: the diff shows and the write lands.
  - "More info" cites its sources.
- **Failure paths:** endpoint down → status in the header and a clear message. Malformed JSON or a
  step-cap hit → error, nothing executed. Cancel mid-agent → no proposal applied.

## Status (2026-10-03)

**Phase 0 (host) — built on `worktree-3`, uncommitted.**
- `mcp/tools.mjs` — the catalog split out of `viboplr-mcp.mjs`, each tool with
  `readOnly` / `readOnlyWhen` / `categories` / `transports`; `tools.d.mts` types.
  `viboplr-mcp.mjs` is now transport only (all 51 existing MCP tests unchanged
  and passing). Both files are bundled (`tauri.conf.json` resources).
- `control_api_call` command → `ControlApi::call_in_process` → `call_router`
  (same router via `oneshot`, same auth + write scopes; refused while AI control
  is off). 4 Rust tests.
- `api.assistant.host` (`utils/hostAssistantTools.ts`, wired in `usePlugins`),
  permission `assistant:host` (fail-closed, sensitive in the consent UI).
  `src/__tests__/assistantTools.test.ts`.
- Docs: plugins.md, backend.md, mcp/README.md.
- Not done: user-configured network hosts (the plugin declares `network:*`
  instead, which the user approves at install).

**Plugin — `~/Code/viboplr-llm` (id `llm`, v0.1.0), not a git repo yet, no GitHub
repo created.** Chat view with Approve/Deny, Cmd+K Ask provider (grounded),
6 context-menu errands, Meaning info type, `complete` assistant tool. 37 tests
(`node --test`). Not live-tested against the app or a real model.
