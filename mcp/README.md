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

1. In Viboplr: **Settings → General → AI remote control** — switch it on.
2. Register the server with your client:

**Claude Code**

```bash
claude mcp add viboplr -- node /path/to/viboplr/mcp/viboplr-mcp.mjs
```

**Claude Desktop** (`claude_desktop_config.json` → `mcpServers`)

```json
"viboplr": {
  "command": "node",
  "args": ["/path/to/viboplr/mcp/viboplr-mcp.mjs"]
}
```

The app doesn't need to be running when the client starts — tools answer with a
pointer at the Settings toggle until it is.

## Tiers

By default the server exposes the music surface: search/browse, playback and
queue control, playlists, likes, tags, lyrics/info, plugin catalogs
(YouTube/Spotify/TIDAL search + play), plugin home shelves, collections
(list + rescan — never add/remove), and the app
version (`app_version` — with `checkLatest` it also reads the newest stable
release from GitHub's `releases/latest` for `outcast1000/viboplr` and says
whether the app is current; report-only, updates install from inside the app).

`--tier=full` (or `VIBOPLR_MCP_TIER=full`) adds the power verbs: plugin
context-menu actions, plugin deep links, extension/skin management, window
control, and log access.

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

## Multiple profiles

The server picks the `default` profile (or the only running one). Running a
non-default profile? Pass `--profile=<name>` (or `VIBOPLR_MCP_PROFILE`).

## What it can never do

Same as the API: no file deletion, no audio-file metadata writes, no downloads,
no playlist deletion, and no extension install/delete — an install verb would
turn the token into arbitrary code execution, so it is a permanent non-goal.
