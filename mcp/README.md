# Viboplr MCP server

A dependency-free stdio [MCP](https://modelcontextprotocol.io) server that lets
MCP clients — Claude Desktop, Claude Code, Cursor, … — control a running
Viboplr through its localhost control API. It is a pure translation layer: the
Rust API (see `skills/viboplr-control/SKILL.md` for the HTTP surface) owns
every capability decision; this server only discovers the app, holds the bearer
token, and presents typed tools. The token never appears in tool results, so it
never reaches the model or the client transcript.

Requires Node ≥ 18. No `npm install` — the script is self-contained.

## Setup

1. In Viboplr: **Settings → General → AI control** — switch it on.
2. Register the server with your client.

**From the app (easiest).** This script **ships in the bundle**
(`bundle.resources` in `tauri.conf.json` maps it to `Resources/mcp/`), so there
is nothing to download. With the toggle on, the same settings card offers
**Copy config** / **Copy command** / **Show file** — the copied block already
carries the script's absolute path, the absolute path of a `node` that can run
it, and `--profile=` when the app is on a named profile. Paste it into your
client and relaunch.

The absolute `node` path is the point rather than a nicety: GUI apps launch
without the shell's PATH, so a bare `"command": "node"` often resolves to
nothing and the server simply never appears. `src-tauri/src/mcp_setup.rs`
resolves it (PATH, then the usual install dirs, then volta/asdf/nvm/fnm) and
reports when Node is missing or older than 18.

**By hand.** Point your client at the bundled copy (macOS:
`/Applications/Viboplr.app/Contents/Resources/mcp/viboplr-mcp.mjs`), a checkout,
or a downloaded copy of this file:

**Claude Code**

```bash
claude mcp add viboplr -- /absolute/path/to/node /path/to/mcp/viboplr-mcp.mjs
```

**Claude Desktop** (`claude_desktop_config.json` → `mcpServers`)

```json
"viboplr": {
  "command": "/absolute/path/to/node",
  "args": ["/path/to/mcp/viboplr-mcp.mjs"]
}
```

The app doesn't need to be running when the client starts — tools answer with a
pointer at the Settings toggle until it is, and the `launch_app` tool starts the
installed app on request and waits for its API to answer (the toggle persists,
so a launched app brings the API up on its own).

## Tiers

By default the server exposes the music surface: search/browse, playback and
queue control, playlists, likes, tags, lyrics/info (incl. `search_info`, a
substring search over the cached plugin info values — find a track by a lyric
phrase, local file lyrics included), plugin catalogs
(YouTube/Spotify/TIDAL search + play), plugin home shelves, collections
(list + rescan — never add/remove), ad-hoc read-only SQL over the library
database (`query_library` — writes and the credential tables are refused
server-side), and the app
version (`app_version` — with `checkLatest` it also reads the newest stable
release from GitHub's `releases/latest` for `outcast1000/viboplr` and says
whether the app is current; report-only, updates install from inside the app).

`--tier=full` (or `VIBOPLR_MCP_TIER=full`) adds the power verbs: plugin
context-menu actions, plugin deep links, plugin assistant tools (each plugin
can publish its own AI tools + instructions — list and invoke them via
`plugin_tools`), extension/skin management (per-plugin capability summaries,
one plugin's full detail, and read-only gallery browsing for recommendations —
install/delete stays a permanent non-goal), window control, and log access.

```json
"args": ["/path/to/viboplr/mcp/viboplr-mcp.mjs", "--tier=full"]
```

The active tier is visible from inside a chat: the `app_version` tool reports
it (`mcp.tier`, alongside the server's own version), and the server's
initialize instructions declare it — so the model can explain *why* a power
tool is missing and how to enable it, instead of just failing to find one.

The default is deliberate: lyrics, bios and catalog results are untrusted web
content that flows into the model's context, and the tier bounds what an
injected instruction could reach. Turn on `full` per client, where you want it
— e.g. full in Claude Code, default in Claude Desktop. Note the tier changes
which tools the *model sees*, not what the token authorizes; it is an
ergonomics/injection boundary, not an authorization one.

## Write permissions

Four tools can change the user's files, and they sit **outside the tier
system**: `write_file_tags` (tag/metadata edits written into the audio files —
the app's canonical bulk edit), `manage_files` (lyrics/cover sidecar files;
two-step plan-then-apply moves/renames within a collection; the change log),
`download_track` (a track's *own* subsonic/http source, as itself, into a
local collection — never resolved through a download provider), and
`download_plugin_track` (a plugin-sourced track through the plugin that OWNS
it — a catalog_search result, a plugin-scheme library track/URI, or a
metadata resolve with an explicit pluginId; the app never picks the provider.
One at a time, cancellable — the resolve can *be* the whole download).

Their authorization is not the tier but **per-category switches in Viboplr →
Settings → General → AI control**, all off by default, enforced in Rust on
every request and re-read from disk each time (flipping a switch applies
immediately; a missing/corrupt permissions file means *no*). A refused call is
a 403 naming the switch. `app_version` reports the current switches
(`writeScopes`), and every applied write is journaled to the app's assistant
change log (Settings → Debug, `manage_files action=changes`, and problem
reports).

Structural guardrails, independent of the switches: destinations are always
derived or collection-root-relative and validated in Rust (no absolute paths,
no `..`, symlink-escape checked); nothing is ever silently overwritten
(explicit `overwrite` trashes the old file; moves and downloads refuse
conflicts outright); moves keep the library row (id, tags, likes, playlists)
pointed at the file; batches are capped (100 tag writes, 50 moves).

## Renaming history

`rename_history` is the DB-only companion to `write_file_tags`. Listening
history is keyed by name and never follows a tag edit, so correcting a
transliterated or misspelled artist leaves every past play stranded under the
old spelling; this tool re-files them (whole artist, or one track with a new
title and/or artist). It needs no permission switch — no file is touched — but
landing on a name that already has history **merges** into it, which cannot be
undone, so the tool takes `dryRun: true` and reports the counts first. Applied
renames land in the same change log as the file writes.

## Multiple profiles

The server picks the `default` profile (or the only running one). Running a
non-default profile? Pass `--profile=<name>` (or `VIBOPLR_MCP_PROFILE`).

## What it can never do

Same as the API: no file deletion, no playlist deletion, and no extension
install/delete — an install verb would turn the token into arbitrary code
execution, so it is a permanent non-goal. File-metadata writes, sidecar file
creation, in-collection moves and downloads exist but only behind the
per-category write permissions above; there is no way to write outside a
collection root, overwrite silently, or have the host pick a download
provider on the user's behalf (a plugin download always names its plugin —
by scheme ownership or an explicit pluginId).
