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

## Tools

Every tool is always listed: search/browse, playback and queue control,
playlists, likes, tags, lyrics/info (incl. `search_info`, a substring search
over the cached plugin info values — find a track by a lyric phrase, local file
lyrics included), plugin catalogs (YouTube/Spotify/TIDAL search + play), plugin
home shelves, collections (list + rescan — never add/remove), ad-hoc read-only
SQL over the library database (`query_library` — writes and the credential
tables are refused server-side), the app version (`app_version` — with
`checkLatest` it also reads the newest stable release from GitHub's
`releases/latest` for `outcast1000/viboplr` and says whether the app is
current; report-only, updates install from inside the app), extension/skin
management (per-plugin capability summaries, one plugin's full detail, and
read-only gallery browsing for recommendations — install/delete stays a
permanent non-goal), window control, log access, entity images, and the plugin
surfaces: context-menu actions, deep links, and **plugin assistant tools**.

Each plugin can publish its own AI tools + instructions. They are reachable
through `plugin_tools` (list / invoke) and are also listed as their own tools
named `<pluginId>__<tool>`, e.g. `spotify-browse__get_playlist_tracks`, so a
model finds them by name instead of having to know `plugin_tools` exists. The
roster is read from the running app; when the app starts later the server
announces the new tools with `notifications/tools/list_changed`. A tool the
plugin declared `readOnly` carries MCP's `readOnlyHint: true`; the others say
in their description that they need the **Plugin actions** switch.

### Why there is no `--tier` flag any more

Earlier versions hid the "power" tools unless the client config passed
`--tier=full`. It was meant to limit what an instruction injected through
fetched web text (lyrics, bios, catalog results) could reach, but it gated by
*client config* rather than by *consequence*: window control and log reads sat
behind it, while every plugin tool — including pure reads like "list the
tracks of my Daily Mix 1" — was unreachable without it. And because it lived
in a hand-edited config, it silently differed between clients: the same
question worked in one and dead-ended in the other.

What an assistant may *change* is now decided where the user can see it — the
per-category switches below, enforced in Rust on every request. `--tier` is
still accepted and ignored, so existing configs keep starting.

## Write permissions

Five tools can change the user's files: `write_file_tags` (tag/metadata
edits written into the audio files — the app's canonical bulk edit), `manage_files` (lyrics/cover sidecar files;
two-step plan-then-apply moves/renames within a collection; the change log),
`download_track` (a track's *own* subsonic/http source, as itself, into a
local collection — never resolved through a download provider), and
`download_plugin_track` (a plugin-sourced track through the plugin that OWNS
it — a catalog_search result, a plugin-scheme library track/URI, or a
metadata resolve with an explicit pluginId; the app never picks the provider.
One at a time, cancellable — the resolve can *be* the whole download), and
`replace_track_file` (swap a local library track's file for a better copy
resolved the same way — e.g. a finished Soulseek download's `slsk://` uri —
keeping the library row; two-step: stage + compare, then confirm or discard;
needs both the Downloads and Manage files switches, and the old file goes to
the Trash).

Their authorization is a **per-category switch in Viboplr → Settings →
General → AI control**, all off by default, enforced in Rust on
every request and re-read from disk each time (flipping a switch applies
immediately; a missing/corrupt permissions file means *no*). A refused call is
a 403 naming the switch.

A fourth switch, **Plugin actions**, covers the plugin surfaces, because a
plugin's code can do anything the app can: invoking a context-menu action
(`plugin_actions` invoke), delivering a deep link (`plugin_deep_link`), and
calling any plugin tool **not** declared `readOnly` (a Soulseek download, a
playlist push). Read-only plugin tools — lookups, searches, cached lists —
always run. The classification is the plugin's own declaration (`readOnly` on
the tool — see `.claude/rules/plugins.md` → Assistant Tools); a tool that
declares nothing is treated as one that changes things. Listing actions and
tools never needs the switch. Plugin-to-plugin calls (`api.assistant.invoke`)
are not gated — the switch is about what the *assistant* may do.

`app_version` reports the current switches (`writeScopes`), and every applied write is recorded in the app log as an
`Assistant change [...]` line (the `logs` tool and problem reports, while
logging is on).

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
