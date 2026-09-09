---
name: viboplr-control
description: Control a running Viboplr music player over its localhost HTTP API — search the library, control playback, edit the queue, playlists, tags and likes. Use when the user asks to play/pause/queue music, make or edit playlists, tag or like tracks, or ask what's playing in Viboplr.
---

# Controlling Viboplr

Viboplr (the desktop music player) can expose a **token-protected HTTP API on 127.0.0.1**. It is off by default — the user enables it in **Settings → General → AI remote control**. If discovery fails, ask them to switch it on there.

## 1. Discover the server

Each running profile writes a discovery file:

- macOS: `~/Library/Application Support/com.alex.viboplr/profiles/*/control-api.json`
- Windows: `%APPDATA%\com.alex.viboplr\profiles\*\control-api.json`
- Linux: `~/.local/share/com.alex.viboplr/profiles/*/control-api.json`

It holds `{ port, token, profile, pid, startedAt }`. **Never trust it blindly** — a crashed app leaves a stale file. Always verify first:

```bash
F=$(ls ~/Library/Application\ Support/com.alex.viboplr/profiles/*/control-api.json 2>/dev/null | head -1)
PORT=$(python3 -c "import json;print(json.load(open('$F'))['port'])")
vc() { python3 -c "import json;print('Authorization: Bearer '+json.load(open('$F'))['token'])" \
  | curl -sf -H @- -H 'Content-Type: application/json' "$@"; }
vc "http://127.0.0.1:$PORT/v1/health"
```

A healthy answer is `{"ok":true, "version":…, "profile":…}`. Multiple files = multiple app instances (profiles); pick by the `profile` field, `default` for a normal install.

**Token hygiene (hard rule):** the token must never appear in a shell variable, a command line, command output, or any file you write. It flows from the discovery file straight into curl over the stdin pipe (`-H @-`) inside `vc`, and nowhere else — never `cat` the discovery file or extract its `token` field into output. Shell state does not persist between commands, so re-run the setup lines (`F`, `PORT`, `vc`) at the start of every shell invocation.

## 2. Rules of the road

- Every request needs the `Authorization: Bearer` header — always sent through the `vc` helper above (token piped via `-H @-`), never inline on the command line. Bodies are JSON: `vc -X POST -d '{"play":true}' "http://127.0.0.1:$PORT/v1/playback"`.
- Errors come back as `{"error": "message"}` with 400/401/404. **503** = app still starting (wait, retry). **504** = webview busy (retry once).
- Track ids come from `/v1/search` — they are library ids. Playlist **row** ids (a different id space!) come from `/v1/playlists/{id}/tracks` and are what remove/reorder take.
- All mutations are queue/playlist/tag/like/extension-toggle level. The API cannot delete files, rewrite audio-file metadata, **install or delete extensions**, or touch anything outside the library. Extension install/delete is a permanent non-goal (an install verb would let the token run arbitrary code) — never suggest working around it.
- After `POST /v1/playback`, read `GET /v1/status` for the settled state (the command returns before UI state has updated).
- Plugin/external tracks resolve their stream at play time (often via yt-dlp) — after playing one, `/v1/status` can show the previous track for ~10–20s until resolution completes. Wait and re-read before concluding a play failed.

## 3. Endpoints (all under `/v1`)

**Read + search**

| Endpoint | Notes |
|---|---|
| `GET /health` | liveness + version/profile |
| `GET /search?q=…&type=all\|track\|artist\|album\|tag&limit=20` | FTS search — see "Search responses" below |
| `GET /tracks/{id}` | full track row |
| `GET /status` | playing, position, volume, queue index/length, current track (with `libraryId`) |
| `GET /queue` | `{index, mode, tracks:[{index, libraryId, title, artistName, …, current}]}` — `libraryId` is the id other endpoints take (null for external entries) |
| `GET /playlists` · `GET /playlists/{id}/tracks` | the latter returns playlist **row ids** |
| `GET /artists/{id}/tracks` · `GET /artists/{id}/albums` | browse an artist (ids from search) |
| `GET /albums/{id}/tracks` | the album's tracks **in track order** — prefer this over search+filter for queuing albums |
| `GET /tags/{id}/tracks` | all tracks carrying a tag |
| `GET /picks?kind=liked\|never_played\|forgotten_favorites&limit=50` | curated lists: the liked set, never-played tracks, often-played-but-not-lately favorites |
| `GET /history?kind=recent\|most_played&limit=20` | listening history |
| `GET /tags?limit=&offset=` | library tags with track counts |

**Search responses** (raw library rows, snake_case — unlike the camelCase status/queue shapes):
- `type=all` → `{artists: [..], albums: [..], tracks: [..]}` (no `total`)
- `type=track|artist|album|tag` → `{tracks?|artists?|albums?|tags?: [..], total}` — only the matching key is set
- A track row: `{id, title, artist_name, album_title, artist_id, album_id, duration_secs, path, format, liked, year, track_number, …}`. `id` is the library id every other endpoint takes.
- Artist/album/tag rows: `{id, name|title, artist_name?, track_count, liked}`

**Playback + queue**

| Endpoint | Body |
|---|---|
| `POST /playback` | `{play?: bool, action?: "next"\|"prev"\|"stop", seekSecs?: n, volume?: 0..1, mode?: "normal"\|"repeat-all"\|"repeat-one"}` — `play` is idempotent (true = playing, false = paused); `mode` sets the repeat mode |
| `POST /queue/jump` | `{index}` — play that queue position (indices from `GET /queue`) |
| `POST /queue/play` | `{trackIds: [..], contextName?: "…"}` — replaces the queue and plays |
| `POST /queue/tracks` | `{trackIds, mode?: "end"\|"next", allowDuplicates?: bool}` → `{added, skippedDuplicates}` (duplicates are skipped and counted unless allowed) |
| `DELETE /queue/tracks` | `{indices: [..]}` — queue positions from `GET /queue` |
| `POST /queue/clear` | — |
| `POST /queue/randomize` | — one-shot shuffle around the playing track (refused in repeat-one or under 2 tracks) |
| `POST /radio` | `{trackId}` or `{title, artistName?}` — builds a ~30-track station from the seed, replaces the queue, plays → `{queued, station}` |
| `POST /playlists/{id}/play` | — loads a saved playlist (system/auto ones too) into the queue and plays → `{queued, name}` |
| `POST /playlists/{id}/enqueue` | `{mode?: "end"\|"next", allowDuplicates?}` — adds a saved playlist to the queue without replacing it → `{added, skippedDuplicates, name}` |

**Playlists** (user playlists only — system/auto playlists are refused)

| Endpoint | Body |
|---|---|
| `POST /playlists` | `{name, description?, trackIds?}` → `{playlistId}` |
| `POST /playlists/{id}/tracks` | `{trackIds, allowDuplicates?}` → `{added, skipped, skippedIndices}` |
| `DELETE /playlists/{id}/tracks` | `{playlistTrackIds: [..]}` — **row ids**, not track ids |
| `PUT /playlists/{id}/order` | `{orderedIds: [..]}` — the full permutation of row ids |
| `PATCH /playlists/{id}` | `{name, description?}` |

**Plugin catalogs** (search external sources — YouTube, Spotify, TIDAL — through their plugins)

| Endpoint | Body / notes |
|---|---|
| `GET /search/providers` | → `{providers: [{key, pluginId, providerId, name}]}` — which catalogs are installed and enabled |
| `POST /search/plugin` | `{provider: "<key>", query, limit?}` → `{searchId, tracks: [{index, title, artistName, …, video}]}`. **Slow** — a catalog search can take up to a minute (yt-dlp shells out); use a 90s curl timeout. Empty result → `searchId: null` |
| `POST /queue/play-search` | `{searchId, indices?, mode?: "play"\|"end"\|"next", allowDuplicates?}` — play (default, replaces queue) or enqueue tracks from a previous plugin search. Results are cached per session (last 8 searches); an expired `searchId` means re-run the search |

External results have no library ids — they are addressed only via `searchId` + `index`. Playback rides the plugin's own stream resolver (e.g. a Spotify result typically plays through yt-dlp).

**Plugin home shelves** (curated collections plugins contribute — e.g. Spotify's Daily Mixes / Made For You)

| Endpoint | Body / notes |
|---|---|
| `GET /home/shelves` | → `{shelves: [{key, pluginId, shelfId, title, displayKind}]}` — plugin shelves only (library shelves are covered by /history and /picks) |
| `POST /home/shelf` | `{shelf: "<key>", limit?}` → `{fetchId, items: [{index, name, subtitle, playable, shippedTracks, partial}]}`. Cached per session like plugin searches |
| `POST /home/play` | `{fetchId, index}` — play that card exactly as the Home page's play button would: full lists play at once, lazy cards resolve first (slow — 90s timeout), partial cards start immediately and backfill behind the music |

**Plugin actions** (context-menu verbs plugins contribute — e.g. yt-dlp's "Watch YouTube video")

| Endpoint | Body / notes |
|---|---|
| `GET /actions?target=track\|album\|artist\|multi-track\|playlist` | the installed, user-enabled plugin actions |
| `POST /actions/invoke` | `{actionId, pluginId?, kind?, trackId?\|title+artistName?, trackIds?}` — run one on a target. Fire-and-forget: effects (a view opening, playback, a conversion job) appear in the app, not in the response |

**Plugin deep links** (plugin-defined verbs — e.g. completing an auth flow a plugin documents)

| Endpoint | Body |
|---|---|
| `POST /plugins/{id}/deep-link` | `{path?}` → delivers `viboplr://plugin/{id}/{path}` to that plugin only (scoped — never broadcast) |

**Info values** (lyrics, bios, similar tracks, reviews — fetched by plugins like Last.fm, LRCLIB, Genius)

| Endpoint | Notes |
|---|---|
| `GET /lyrics?title=…&artistName=…` | lyrics for a track — **omit title to use what's playing**. Serves fresh cache instantly; otherwise walks the lyrics provider chain (slow — use a 90s curl timeout). Value shape: `{text, kind: "plain"\|"synced", lines?: [{time, text}]}` |
| `GET /info/entity?kind=track\|artist\|album\|tag&title=…&artistName=…` | the registered info types for that entity + every cached value (`sections: [{typeId, name, displayKind, status, fresh, value}]`). Read-only, instant |
| `POST /info/fetch` | `{kind, title\|name, artistName?, typeId}` — one info type, live: fresh cache served as-is, else fetched through the plugin provider chain and cached (slow; 90s timeout). typeIds come from `/info/entity` (e.g. `lyrics`, `artist_bio`, `similar_artists`) |
| `GET /info/search?q=…&typeId=&displayKind=&entity=&limit=20` | substring search across the cached store — cached only, never triggers a live fetch |

**Entity images** (album covers, artist portraits, tag art)

| Endpoint | Notes |
|---|---|
| `GET /images/{kind}?name=…&artistName=…` | the cached image's **bytes** (kind = artist\|album\|tag; artistName only for albums). 404 = nothing cached yet |
| `POST /images/{kind}` | `{name, artistName?}` — resolve one through the image provider chain (folder art → embedded → plugin providers). Async: returns `{started: true}`; retry the GET after a few seconds |

**Window control**

| Endpoint | Body / notes |
|---|---|
| `GET /window` | `{visible, minimized, maximized, fullscreen, mini}` |
| `POST /window` | any of `{visible, minimized, maximized, fullscreen, mini, focus}` as booleans — all idempotent sets (`mini` = the mini player). **The response snapshot lags the OS animation and React state — treat it as advisory and read `GET /window` ~2s later for the settled state.** Entering fullscreen needs a current track (the loaded/paused one counts) |

**Logs & debugging**

| Endpoint | Notes |
|---|---|
| `GET /logs` | backend log tail (last 200 lines; file is truncated per launch; home dir scrubbed to `~`). Says when file logging is off |
| `POST /logs` | `{enabled?, debug?}` — file logging takes effect on the **next app launch**; debug (frontend activity) logging is live |
| `GET /logs/frontend` | in-memory ring buffers, always on even with file logging off: uncaught frontend errors, stream-resolver activity (what played through which resolver and why), plugin `api.log` lines (`pluginLog`), and recent toasts (`notifications`). The last two are how to see why a fire-and-forget verb (e.g. a plugin action) failed — its outcome surfaces only as a toast + plugin log line |

Consent rule for logs: show the user before posting log contents anywhere public (an issue, a gist) — same model as the app's own "Report a problem".

**Extensions + skins** (list, toggle, update-check, apply skin — never install/delete)

| Endpoint | Body |
|---|---|
| `GET /extensions` | → `{plugins: [{id, name, version, enabled, status, builtin}], skins: [{id, name, type, active}], updates: [..], checking, updatesCheckedAt}` — `updates` reflects the last check |
| `POST /extensions/{id}/enabled` | `{enabled: bool}` — enable/disable an installed plugin (reloads the plugin runtime; takes a moment) |
| `POST /extensions/check-updates` | — starts a check in the background → `{started: true}`; poll `GET /extensions` after ~15s for results |
| `POST /skins/apply` | `{id}` or `{name}` (case-insensitive) — switch the app's skin |

**Collections** (list + rescan — adding/removing collections stays in the app)

| Endpoint | Body / notes |
|---|---|
| `GET /collections` | the user's music sources with kind, enabled, sync status/errors and track counts. Credentials are never included |
| `POST /collections/{id}/rescan` | `{full?: bool}` — re-sync one collection with disk/server. Returns `{started, name, full}` immediately; the scan runs in the background (confirm via `GET /collections` — `last_synced_at` moves — or by searching for the new tracks). `full` re-reads every file's tags, bypassing the mtime fast path (expensive; for external tag edits) |

**Tags + likes**

| Endpoint | Body |
|---|---|
| `POST /tracks/{id}/tags` | `{add?: ["chill"], remove?: ["rock"]}` → `{tags: [..]}` (final set; database tags only, files untouched) |
| `POST /likes` | `{kind: "track", likeState: -1\|0\|1, title, artistName?, albumTitle?}` or `{kind: "artist"\|"tag", name, likeState}` or `{kind: "album", title, artistName?, likeState}` |

## 4. Recipes

**Play something mellow**
1. `GET /search?q=mellow&type=tag` → tag hit (or search tracks directly)
2. `GET /search?q=<tag name>&type=track&limit=30` → collect `id`s
3. `POST /queue/play {"trackIds":[…], "contextName":"Mellow"}`

**Build a playlist from most-played**
1. `GET /history?kind=most_played&limit=30` → titles/artists
2. `GET /search?q=<title artist>&type=track` per entry → ids
3. `POST /playlists {"name":"On repeat","trackIds":[…]}`

**Like what's playing**
1. `GET /status` → `currentTrack.title` / `artistName`
2. `POST /likes {"kind":"track","likeState":1,"title":…,"artistName":…}`

**Queue an album next**
1. `GET /search?q=<album>&type=album` → the album's `id`
2. `GET /albums/{id}/tracks` → ids, already in track order
3. `POST /queue/tracks {"trackIds":[…], "mode":"next"}`

**Put an album on repeat**
1. Play it (`/albums/{id}/tracks` → `/queue/play`)
2. `POST /playback {"mode":"repeat-all"}`

**Play forgotten favorites**
1. `GET /picks?kind=forgotten_favorites&limit=25` → ids
2. `POST /queue/play {"trackIds":[…], "contextName":"Forgotten favorites"}`

**Play a song that isn't in the library (via a plugin)**
1. `GET /search/providers` → pick a catalog (e.g. `ytdlp:youtube`)
2. `POST /search/plugin {"provider":"ytdlp:youtube","query":"artist song"}` (long timeout!) → `searchId` + tracks
3. `POST /queue/play-search {"searchId":"s1","indices":[0]}`

**"Play my Spotify Daily Mix 2"**
1. `GET /home/shelves` → find the Spotify shelf key
2. `POST /home/shelf {"shelf":"<key>"}` → cards with a `fetchId`
3. `POST /home/play {"fetchId":"h1","index":<the mix>}`

**"What are the lyrics to this?"** → `GET /lyrics` (no params — uses the playing track)

**"I added new music — update my library"**
1. `GET /collections` → pick the collection whose `path`/`url` covers the new files
2. `POST /collections/{id}/rescan` (add `{"full":true}` only when tags were edited externally)
3. Poll `GET /collections` until `last_synced_at` moves, or search for the new tracks. New files only appear if their folder is inside an existing collection — there is no verb to add one.

**"What version is Viboplr, and is it current?"**
1. `GET /health` → `version` (the running app)
2. Latest stable release: `GET https://api.github.com/repos/outcast1000/viboplr/releases/latest` → `tag_name` (strip the leading `v`; `releases/latest` already excludes betas/prereleases). Report-only — updates are installed from inside the app (Settings → General), never from here.

**"Tell me about this artist"**
1. `GET /info/entity?kind=artist&name=<artist>` → see what's cached
2. Missing? `POST /info/fetch {"kind":"artist","name":…,"typeId":"artist_bio"}` (or `similar_artists`, `artist_top_tracks`…)

**Start a radio station from what's playing**
1. `GET /status` → `currentTrack.libraryId` (or title/artist for external tracks)
2. `POST /radio {"trackId": <id>}` (or `{"title":…, "artistName":…}`)

**Shuffle and play a saved playlist**
1. `GET /playlists` → pick the id
2. `POST /playlists/{id}/play` then `POST /queue/randomize`

## 5. Install (for the user)

From the Viboplr repo: `ln -s "$(pwd)/skills/viboplr-control" ~/.claude/skills/viboplr-control`
